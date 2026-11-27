import type { Match } from './match';
import type { Fighter } from './fighter';
import { TUNING } from './fighter';

// Layered vitality (lasting health behind recoverable stamina), energy with quarter ticks, Rage,
// Danger and finisher prompts. Panels have opaque backing so they stay legible over explosions.

export class HUD {
  el: HTMLElement;
  private panels: HTMLElement[] = [];
  /** Lookup for fighter portrait images (set once portraits are rendered). */
  portraits: ((id: string) => string) | null = null;
  private center: HTMLElement;
  private sub: HTMLElement;
  constructor(root: HTMLElement) {
    this.el = root;
    root.innerHTML = `
      <div class="hud-p p0"></div>
      <div class="hud-p p1"></div>
      <div class="hud-center"><div class="hud-big"></div><div class="hud-sub"></div></div>`;
    for (const i of [0, 1]) {
      const p = root.querySelector(`.p${i}`) as HTMLElement;
      p.innerHTML = `
        <div class="por"><span class="ini"></span><span class="tag">P${i + 1}</span></div>
        <div class="meters">
          <div class="pips">${'<b><i></i></b>'.repeat(4)}<span class="nm"></span><span class="lives"></span></div>
          <div class="bar vit"><div class="hp"></div><div class="st"></div></div>
          <div class="bar rg"><div class="fill"></div></div>
          <div class="flags"><span class="danger">DANGER</span><span class="rage">RAGE</span><span class="fin"><kbd>RT</kbd>+<kbd>Y</kbd> FINISH</span><span class="note"></span></div>
          <div class="ctl"></div>
        </div>`;
      this.panels.push(p);
    }
    this.center = root.querySelector('.hud-big') as HTMLElement;
    this.sub = root.querySelector('.hud-sub') as HTMLElement;
  }

  setNames(m: Match, controllers: string[]) {
    m.fighters.forEach((f, i) => {
      const p = this.panels[i];
      (p.querySelector('.nm') as HTMLElement).textContent = f.def.name;
      (p.querySelector('.nm') as HTMLElement).style.color = f.def.color;
      const por = p.querySelector('.por') as HTMLElement;
      por.style.setProperty('--c', f.def.color);
      const url = this.portraits?.(f.def.id) ?? '';
      const ini = p.querySelector('.ini') as HTMLElement;
      ini.textContent = url ? '' : f.def.name[0];
      por.style.backgroundImage = url ? `url(${url})` : '';
      (p.querySelector('.ctl') as HTMLElement).textContent = controllers[i];
    });
  }

  show(on: boolean) {
    this.el.style.display = on ? '' : 'none';
  }

  update(m: Match, time: number) {
    m.fighters.forEach((f, i) => this.updatePanel(this.panels[i], f, time));
    let big = '', sub = '';
    if (m.introT > 45) { big = m.livesMax > 1 ? `ROUND ${m.round}` : 'READY'; if (m.livesMax > 1) sub = `${m.lives[0]} ♥  vs  ${m.lives[1]} ♥`; }
    else if (m.introT > 0) big = 'FIGHT!';
    if (m.ended) {
      const how = m.ended.how === 'ko' ? 'K.O.' : m.ended.how === 'ringout' ? 'RING OUT' : 'FINISHER';
      big = how;
      if (m.finalBout) sub = `${m.ended.winner.def.name} WINS`;
      else {
        const left = m.lives[m.ended.loser.idx] - 1;
        sub = `${m.ended.loser.def.name} · ${left} ${left === 1 ? 'LIFE' : 'LIVES'} LEFT`;
      }
    }
    this.center.textContent = big;
    this.sub.textContent = sub;
    this.center.className = 'hud-big' + (m.ended ? ' end ' + m.ended.how : big ? ' intro' : '');
  }

  private updatePanel(p: HTMLElement, f: Fighter, time: number) {
    const lv = p.querySelector('.lives') as HTMLElement;
    const m = f.match;
    if (m.livesMax > 1) {
      // Lives still in hand; the one being lost right now dims.
      const losing = m.ended && m.ended.loser === f ? 1 : 0;
      const n = m.lives[f.idx];
      const key = `${n}/${m.livesMax}/${losing}`;
      if (lv.dataset.k !== key) { lv.dataset.k = key; lv.innerHTML = Array.from({ length: m.livesMax }, (_, k) => `<u class="${k < n - losing ? 'on' : k < n ? 'go' : ''}"></u>`).join(''); }
    } else if (lv.dataset.k) { lv.dataset.k = ''; lv.innerHTML = ''; }
    const hp = p.querySelector('.hp') as HTMLElement;
    const st = p.querySelector('.st') as HTMLElement;
    hp.style.width = `${f.health}%`;
    st.style.width = `${f.stamina}%`;
    // Energy as four quarter pips: one pip = the finisher threshold.
    const pips = p.querySelectorAll<HTMLElement>('.pips i');
    pips.forEach((el, k) => { el.style.width = `${Math.max(0, Math.min(1, (f.energy - k * 25) / 25)) * 100}%`; });
    const pipRow = p.querySelector('.pips') as HTMLElement;
    pipRow.classList.toggle('flash', f.noPowerFlash > 0 && Math.floor(time * 12) % 2 === 0);
    pipRow.classList.toggle('unlimited', f.raging);
    const rg = p.querySelector('.rg .fill') as HTMLElement;
    const rageTag = p.querySelector('.rage') as HTMLElement;
    if (f.raging) {
      rg.style.width = `${(f.rageTime / TUNING.rageDuration) * 100}%`;
      rg.parentElement!.classList.add('on');
      rg.parentElement!.classList.remove('ready');
      rageTag.style.display = '';
      rageTag.textContent = `RAGE ${f.rageTime.toFixed(1)}`;
    } else {
      rg.style.width = `${f.rage}%`;
      rg.parentElement!.classList.remove('on');
      const ready = f.rage >= 100;
      rg.parentElement!.classList.toggle('ready', ready);
      rageTag.style.display = ready ? '' : 'none';
      rageTag.textContent = 'RAGE · TAP RT';
    }
    (p.querySelector('.danger') as HTMLElement).style.display = f.danger ? '' : 'none';
    (p.querySelector('.danger') as HTMLElement).style.opacity = Math.floor(time * 4) % 2 === 0 ? '1' : '0.45';
    const o = f.opp;
    const canFin = o.danger && f.hasEnergy(TUNING.finisherCost) && f.alive;
    (p.querySelector('.fin') as HTMLElement).style.display = canFin ? '' : 'none';
    (p.querySelector('.note') as HTMLElement).textContent = f.noticeT > 0 ? f.notice : '';
  }
}
