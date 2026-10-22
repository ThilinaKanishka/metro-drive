import { loadPrefs, savePrefs } from '../core/storage.js';

/**
 * Score (per session) and money (persistent wallet). Every change shows a
 * small popup on the HUD. Drift points are accumulated here too: a drift
 * that lasts long enough pays out when the car straightens up.
 */
export class Score {
  constructor(hud) {
    this.hud = hud;
    this.points = 0;
    this.money = Number(loadPrefs().money) || 0;
    this.drift = 0;
    this.driftCalm = 0;
  }

  add(points, label) {
    if (!points) return;
    this.points = Math.max(0, this.points + points);
    this.hud.popup(`${points > 0 ? '+' : ''}${points} ${label}`, points > 0 ? 'good' : 'bad');
  }

  earn(amount, label) {
    if (amount <= 0) return;
    this.money += amount;
    this.hud.popup(`+$${amount} ${label}`, 'money');
    savePrefs({ money: this.money });
  }

  /** Pay if possible; returns the amount actually paid. */
  spend(amount, label) {
    const paid = Math.min(this.money, Math.max(0, Math.round(amount)));
    if (paid > 0) {
      this.money -= paid;
      this.hud.popup(`-$${paid} ${label}`, 'bad');
      savePrefs({ money: this.money });
    }
    return paid;
  }

  resetSession() {
    this.points = 0;
    this.drift = 0;
  }

  /** Called every frame with the player's physics state. */
  updateDrift(dt, phys) {
    const sliding = phys.skid > 0.45 && phys.speed > 8 && Math.abs(phys.vLat) > 2;
    if (sliding) {
      this.drift += dt * phys.speed;
      this.driftCalm = 0;
    } else if (this.drift > 0) {
      this.driftCalm += dt;
      if (this.driftCalm > 0.4) {
        const pts = Math.round(this.drift * 2);
        if (pts >= 30) this.add(pts, 'Drift');
        this.drift = 0;
      }
    }
  }
}
