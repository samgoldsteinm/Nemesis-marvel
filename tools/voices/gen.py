# Regenerate fighter voice lines: python3 -m venv venv && venv/bin/pip install piper-tts numpy scipy librosa soundfile;
# download the Piper models listed in PERSONA into ./models (rhasspy/piper-voices), then venv/bin/python gen.py [fighterIds...]
# Generates every intro line for every fighter with a persona voice treatment.
# Output: public/voices/<id>/<key>.mp3 + public/voices/manifest.json (file, duration, 30 fps mouth envelope).
import re, io, wave, json, os, subprocess, sys
import numpy as np
from scipy import signal
import librosa
from piper import PiperVoice, SynthesisConfig

ROOT = '/home/user/Nemesis-marvel'
OUT = f'{ROOT}/public/voices'
SR = 22050
rng = np.random.default_rng(7)

src = open(f'{ROOT}/src/intro.ts').read()
def strings(block):
    return [m.group(2) for m in re.finditer(r"""(['"])((?:\\.|(?!\1).)*)\1""", block)]
lines_block = src[src.index('const LINES'):src.index('};', src.index('const LINES'))]
LINES = {}
for m in re.finditer(r"(\w+): \[(.*?)\],", lines_block, re.S):
    LINES[m.group(1)] = [s.replace("\\'", "'") for s in strings(m.group(2))]
vs_block = src[src.index('const VERSUS'):src.index('};', src.index('const VERSUS'))]
VERSUS = {m.group(1): m.group(2).replace("\\'", "'") for m in re.finditer(r"'(\w+>\w+)': (?:\"|')(.*?)(?:\"|'),\n", vs_block)}
IDS = ['basalt', 'tether', 'aerin', 'shunt', 'vanta', 'magna', 'ember', 'rift']
NAME = {i: i.capitalize() for i in IDS}

# ---------------------------------------------------------------- DSP helpers
def bq(x, kind, f, order=2):
    sos = signal.butter(order, f, kind, fs=SR, output='sos'); return signal.sosfilt(sos, x)
def reverb(x, secs, mix, damp=4000, pre=0.012):
    n = int(secs * SR); t = np.arange(n) / SR
    ir = rng.standard_normal(n) * np.exp(-t * 6.9 / secs)
    ir = bq(ir, 'low', damp); ir[:int(pre * SR)] = 0; ir /= np.sqrt((ir ** 2).sum())
    wet = signal.fftconvolve(x, ir)[:len(x) + n]
    dry = np.concatenate([x, np.zeros(n)])[:len(wet)]
    y = dry * (1 - mix) + wet * mix * 0.9
    return y
def drive(x, k, mix=1.0):
    y = np.tanh(x * k) / np.tanh(k); return x * (1 - mix) + y * mix
def shift(x, st):
    return librosa.effects.pitch_shift(x.astype(np.float32), sr=SR, n_steps=st, bins_per_octave=12)
def env_follow(x, ms=20):
    a = np.abs(x); n = max(1, int(SR * ms / 1000)); return np.convolve(a, np.ones(n) / n, 'same')
def echo(x, d, fb, n=4, mix=0.35, lp=3000):
    y = np.concatenate([x, np.zeros(int(d * SR * n))]); out = y.copy(); tap = y.copy()
    for i in range(1, n + 1):
        tap = np.roll(tap, int(d * SR)); tap[:int(d * SR)] = 0; tap = bq(tap, 'low', lp) * fb
        out += tap * mix
    return out
def comb(x, ms, fb):
    d = int(SR * ms / 1000); y = x.copy()
    for i in range(d, len(y)): y[i] += fb * y[i - d]
    return y
def crackle(n, rate, amp, hp=2000):
    c = np.zeros(n); idx = rng.random(n) < rate / SR
    c[idx] = rng.standard_normal(idx.sum()) * amp
    return bq(c, 'high', hp)

# ---------------------------------------------------------------- personas
def P_basalt(x):   # rock golem: much deeper, slower, gravel, sub rumble, cavern
    y = librosa.effects.time_stretch(x.astype(np.float32), rate=0.92)
    y = shift(y, -7)
    y = y + 0.5 * shift(y, -12)[:len(y)]
    e = env_follow(y, 30); grav = bq(rng.standard_normal(len(y)), 'band', [90, 900]) * e * 0.55
    y = drive(y + grav, 2.2, 0.6)
    y = bq(y, 'low', 3800)
    y = y + bq(rng.standard_normal(len(y)), 'low', 70) * e * 0.8  # sub rumble with the voice
    return reverb(y, 1.6, 0.32, damp=2500, pre=0.03)
def P_tether(x):   # young, quick, cocky; light mask muffle
    y = shift(x, 1.5)
    y = bq(y, 'low', 6500)
    return reverb(y, 0.35, 0.1)
def P_aerin(x):    # storm sorceress: airy hall, faint electric crackle
    y = shift(x, -0.5)
    air = bq(y, 'high', 5000) * 0.35
    y = y + air
    y = y + crackle(len(y), 22, 0.35, 3000) * env_follow(y, 40) * 4
    return reverb(y, 1.2, 0.26, damp=7000)
def P_shunt(x):    # rebreather/radio: band-limited, light grit, breath
    y = shift(x, -1)
    y = bq(y, 'band', [320, 3300], 3)
    y = drive(y, 3.0, 0.45)
    breath = bq(rng.standard_normal(len(y)), 'band', [1500, 6000]) * 0.008
    y = y + breath * (env_follow(y, 80) < 0.02)
    return reverb(y, 0.25, 0.08)
def P_vanta(x):    # sultry, raspy, purr on loud parts
    y = librosa.effects.time_stretch(x.astype(np.float32), rate=0.93)
    y = shift(y, -1)
    e = env_follow(y, 25); t = np.arange(len(y)) / SR
    purr = 1 + 0.22 * np.sin(2 * np.pi * 27 * t) * np.clip(e / (e.max() + 1e-9) * 2.5, 0, 1)
    rasp = bq(rng.standard_normal(len(y)), 'band', [2500, 7000]) * e * 0.1
    y = drive(y * purr + rasp, 1.6, 0.35)
    return reverb(y, 0.6, 0.14)
def P_magna(x):    # commanding, helmet resonance: comb + subtle ring mod
    y = shift(x, -1.5)
    t = np.arange(len(y)) / SR
    ring = y * np.sin(2 * np.pi * 55 * t)
    y = 0.82 * y + 0.18 * ring
    y = comb(y, 4.2, 0.35) * 0.7
    y = drive(y, 1.4, 0.3)
    return reverb(y, 0.9, 0.18, damp=5000)
def P_ember(x):    # demon: octave-down double, growl AM, fire crackle bed
    y = shift(x, -4)
    y = y + 0.65 * shift(x, -12)[:len(y)]
    t = np.arange(len(y)) / SR; e = env_follow(y, 25)
    y = y * (1 + 0.3 * np.sin(2 * np.pi * 38 * t))
    y = drive(y, 3.0, 0.55)
    fire = bq(crackle(len(y), 60, 1.0, 800) + bq(rng.standard_normal(len(y)), 'low', 600) * 0.15, 'low', 6000) * 0.12
    y = y + fire * (0.4 + e / (e.max() + 1e-9))
    return reverb(y, 1.0, 0.2, damp=3500)
def P_rift(x):     # eerie: soft whisper layer, ghostly chorus, portal ping-pong echo
    e = env_follow(x, 20)
    whisper = bq(rng.standard_normal(len(x)), 'band', [2000, 7000]) * e * 0.25
    t = np.arange(len(x)) / SR
    d = (0.016 + 0.004 * np.sin(2 * np.pi * 0.7 * t)) * SR
    idx = np.clip(np.arange(len(x)) - d, 0, len(x) - 1)
    chorus = np.interp(idx, np.arange(len(x)), x)
    y = 0.8 * x + 0.35 * chorus + whisper
    y = echo(y, 0.19, 0.5, n=3, mix=0.38, lp=4000)
    return reverb(y, 1.2, 0.22, damp=6000)
PERSONA = {
    'basalt': ('en_US-john-medium', SynthesisConfig(length_scale=1.12, noise_scale=0.55, noise_w_scale=0.7), P_basalt),
    'tether': ('en_US-bryce-medium', SynthesisConfig(length_scale=0.88, noise_scale=0.7, noise_w_scale=0.9), P_tether),
    'aerin': ('en_GB-cori-high', SynthesisConfig(length_scale=1.0, noise_scale=0.6, noise_w_scale=0.8), P_aerin),
    'shunt': ('en_US-mike-medium', SynthesisConfig(length_scale=1.02, noise_scale=0.5, noise_w_scale=0.6), P_shunt),
    'vanta': ('en_US-kristin-medium', SynthesisConfig(length_scale=1.06, noise_scale=0.7, noise_w_scale=0.9), P_vanta),
    'magna': ('en_US-norman-medium', SynthesisConfig(length_scale=1.08, noise_scale=0.5, noise_w_scale=0.6), P_magna),
    'ember': ('en_US-joe-medium', SynthesisConfig(length_scale=1.05, noise_scale=0.6, noise_w_scale=0.8), P_ember),
    'rift': ('en_GB-alba-medium', SynthesisConfig(length_scale=1.08, noise_scale=0.6, noise_w_scale=0.8), P_rift),
}

def synth(v, text, cfg):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w: v.synthesize_wav(text, w, syn_config=cfg)
    buf.seek(0)
    with wave.open(buf) as w:
        assert w.getframerate() == SR
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float64) / 32768
    return squeeze_gaps(x)

def squeeze_gaps(x, max_gap=0.22, thr=0.012):
    # Shorten long pauses between sentences (Piper leaves ~0.5-0.8 s) so lines stay punchy.
    e = env_follow(x, 15); quiet = e < thr
    out = []; i = 0; n = len(x); keep = int(max_gap * SR)
    while i < n:
        if quiet[i]:
            j = i
            while j < n and quiet[j]: j += 1
            seg = x[i:j]
            out.append(seg if j - i <= keep or i == 0 or j == n else np.concatenate([seg[:keep // 2], seg[-keep // 2:]]))
            i = j
        else:
            j = i
            while j < n and not quiet[j]: j += 1
            out.append(x[i:j]); i = j
    return np.concatenate(out)

def finish(y):
    y = bq(y, 'high', 60)
    # trim trailing silence (keep reverb tail up to -50 dB)
    a = env_follow(y, 30); keep = np.where(a > a.max() * 0.003)[0]
    y = y[: keep[-1] + int(0.05 * SR)] if len(keep) else y
    # loudness: RMS of voiced part to ~ -18 dBFS, then peak limit to -1 dBFS
    v = y[env_follow(y, 50) > 0.05 * np.abs(y).max()]
    rms = np.sqrt((v ** 2).mean()) if len(v) else 1e-3
    y = y * (10 ** (-18 / 20) / rms)
    pk = np.abs(y).max(); lim = 10 ** (-1 / 20)
    if pk > lim: y = np.tanh(y / pk * 1.2) / np.tanh(1.2) * lim
    fade = int(0.02 * SR); y[-fade:] *= np.linspace(1, 0, fade)
    return y

def mouth(y):
    # 30 fps mouth openness from the speech band envelope, 0..9
    sp = bq(y, 'band', [200, 3500]); e = env_follow(sp, 25)
    hop = SR // 30; frames = np.array([e[i:i + hop].mean() for i in range(0, len(e), hop)])
    frames = frames / (np.percentile(frames, 95) + 1e-9)
    frames = np.clip((frames - 0.08) * 1.25, 0, 1)
    return ''.join(str(int(round(v * 9))) for v in frames)

def encode(y, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pcm = (np.clip(y, -1, 1) * 32767).astype(np.int16).tobytes()
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 's16le', '-ar', str(SR), '-ac', '1', '-i', '-',
                    '-c:a', 'libmp3lame', '-b:a', '32k', path], input=pcm, check=True)

manifest = {}
wav_samples = {}
only = sys.argv[1:] or IDS
for fid in only:
    model, cfg, fx = PERSONA[fid]
    v = PiperVoice.load(f'models/{model}.onnx')
    jobs = []
    for i, line in enumerate(LINES[fid]):
        if '{o}' in line:
            for o in IDS: jobs.append((f'l{i}_{o}', line.replace('{o}', NAME[o])))
        else: jobs.append((f'l{i}', line))
    for k, line in VERSUS.items():
        a, b = k.split('>')
        if a == fid: jobs.append((f'vs_{b}', line))
    entries = {}
    for key, text in jobs:
        y = finish(fx(synth(v, text, cfg)))
        path = f'{OUT}/{fid}/{key}.mp3'
        encode(y, path)
        mm = mouth(y); idx = [i for i, c in enumerate(mm) if int(c) >= 2]
        entries[key] = {'f': f'voices/{fid}/{key}.mp3', 'd': round(len(y) / SR, 2), 's': round((idx[-1] + 1) / 30, 2) if idx else round(len(y) / SR, 2), 'm': mm}
        if fid not in wav_samples: wav_samples[fid] = y
    manifest[fid] = entries
    print(fid, model, len(jobs), 'clips', flush=True)

mpath = f'{OUT}/manifest.json'
old = json.load(open(mpath)) if os.path.exists(mpath) and sys.argv[1:] else {}
old.update(manifest)
json.dump(old, open(mpath, 'w'), separators=(',', ':'))
os.makedirs('samples', exist_ok=True)
import soundfile as sf
for fid, y in wav_samples.items(): sf.write(f'samples/{fid}.wav', y, SR)
