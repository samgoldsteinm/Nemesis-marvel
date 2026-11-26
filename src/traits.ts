// Each fighter's passive trait: a rule that only they play by.
export const TRAITS: Record<string, { name: string; desc: string }> = {
  basalt: { name: 'Bedrock', desc: 'Hyper armour: light hits during his power moves don\'t interrupt him, and he takes 15% less damage.' },
  tether: { name: 'Web Flip', desc: 'Press B again in the air for a second jump.' },
  aerin: { name: 'Static Charge', desc: 'Every third hit she lands discharges a shock that stuns longer and drains extra stamina.' },
  shunt: { name: 'Phase Shift', desc: 'His evade is a blink: he vanishes, travels further and is untouchable the whole way.' },
  vanta: { name: 'Bloodletting', desc: 'Her claw hits make the target bleed, draining stamina over time.' },
  magna: { name: 'Repulse', desc: 'Blocking a melee hit hurls the attacker back with a magnetic burst.' },
  ember: { name: 'Heat Up', desc: 'Below half health he burns hotter: +25% damage and a permanent flame aura.' },
  rift: { name: 'Portal Guard', desc: 'Projectiles that hit her guard vanish into a portal and fly back at the shooter.' },
};
