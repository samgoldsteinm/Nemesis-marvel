import type { Match } from './match';
import type { Fighter } from './fighter';
import { TUNING } from './fighter';

// Layered vitality (lasting health behind recoverable stamina), energy with quarter ticks, Rage,
// Danger and finisher prompts. Panels have opaque backing so they stay legible over explosions.

export class HUD {
  el: HTMLElement;
  private panels: HTMLElement[] = [];
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
        <div class="hud-name"><span class="tag">P${i + 1}</span><span class="nm"></span><span class="ctl"></span></div>
        <div class="bar vit"><div class="hp"></div><div class="st"></div><div class="dm"></div></div>
        <div class="bar en"><div class="fill"></div><i style="left:25%"></i><i style="left:50%"></i><i style="left:75%"></i></div>
        <div class="bar rg"><div class="fill"></div><span class="rlabel">RAGE</span></div>
        <div class="flags"><span class="danger">DANGER</span><span class="fin">FINISH! R+X</span><span class="note"></span></div>`;
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
      (p.querySelector('.ctl') as HTMLElement).textContent = controllers[i];
    });
  }

  show(on: boolean) {
    this.el.style.display = on ? '' : 'none';
  }

  update(m: Match, time: number) {
    m.fighters.forEach((f, i) => this.updatePanel(this.panels[i], f, time));
    let big = '', sub = '';
    if (m.introT > 45) big = 'READY';
    else if (m.introT > 0) big = 'FIGHT!';
    if (m.ended) {
      const how = m.ended.how === 'ko' ? 'K.O.' : m.ended.how === 'ringout' ? 'RING OUT' : 'FINISHER';
      big = how;
      sub = `${m.ended.winner.def.name} WINS`;
    }
    this.center.textContent = big;
    this.sub.textContent = sub;
    this.center.className = 'hud-big' + (m.ended ? ' end ' + m.ended.how : big ? ' intro' : '');
  }

  private updatePanel(p: HTMLElement, f: Fighter, time: number) {
    const hp = p.querySelector('.hp') as HTMLElement;
    const st = p.querySelector('.st') as HTMLElement;
    hp.style.width = `${f.health}%`;
    st.style.width = `${f.stamina}%`;
    const en = p.querySelector('.en .fill') as HTMLElement;
    en.style.width = `${f.energy}%`;
    en.classList.toggle('low', f.energy < TUNING.finisherCost);
    en.classList.toggle('flash', f.noPowerFlash > 0 && Math.floor(time * 12) % 2 === 0);
    const rg = p.querySelector('.rg .fill') as HTMLElement;
    const rl = p.querySelector('.rlabel') as HTMLElement;
    if (f.raging) {
      rg.style.width = `${(f.rageTime / TUNING.rageDuration) * 100}%`;
      rl.textContent = `RAGE ${f.rageTime.toFixed(1)}s — UNLIMITED POWER`;
      rg.parentElement!.classList.add('on');
      rg.parentElement!.classList.remove('ready');
    } else {
      rg.style.width = `${f.rage}%`;
      rg.parentElement!.classList.remove('on');
      const ready = f.rage >= 100;
      rg.parentElement!.classList.toggle('ready', ready);
      rl.textContent = ready ? 'RAGE READY — TAP R' : 'RAGE';
    }
    (p.querySelector('.danger') as HTMLElement).style.visibility = f.danger && Math.floor(time * 4) % 2 === 0 ? 'visible' : 'hidden';
    const o = f.opp;
    const canFin = o.danger && f.hasEnergy(TUNING.finisherCost) && f.alive;
    (p.querySelector('.fin') as HTMLElement).style.display = canFin ? '' : 'none';
    (p.querySelector('.note') as HTMLElement).textContent = f.noticeT > 0 ? f.notice : '';
  }
}
