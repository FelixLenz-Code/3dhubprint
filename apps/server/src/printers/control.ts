import type { PrinterAction, PrinterCapabilities } from '@printhub/shared';
import type { MoonrakerClient } from './moonraker.js';

export class ControlError extends Error {
  constructor(
    public readonly code: 'printer_busy' | 'not_ready' | 'invalid' | 'not_homed' | 'not_printing',
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_SPEEDS = { x: 100, y: 100, z: 10 } as const;

/**
 * Translates UI actions into Moonraker/Klipper commands and enforces safety rules
 * (heater limits, no motion while printing) before anything reaches the printer.
 */
export class PrinterControl {
  constructor(private readonly client: MoonrakerClient) {}

  private get status() {
    return this.client.status;
  }

  private requireReady(): PrinterCapabilities {
    const caps = this.client.capabilities;
    if (!caps || this.status.connection !== 'connected') {
      throw new ControlError('not_ready', 'Drucker ist nicht bereit');
    }
    return caps;
  }

  private get busy() {
    const st = this.status.printState;
    return st === 'printing' || st === 'paused';
  }

  private requireIdle(what: string) {
    if (this.busy) throw new ControlError('printer_busy', `${what} ist während eines Drucks nicht möglich`);
  }

  async action(action: PrinterAction): Promise<void> {
    switch (action) {
      case 'pause':
        if (this.status.printState !== 'printing') throw new ControlError('not_printing', 'Es läuft kein Druck');
        await this.client.request('printer.print.pause');
        return;
      case 'resume':
        if (this.status.printState !== 'paused') throw new ControlError('not_printing', 'Druck ist nicht pausiert');
        await this.client.request('printer.print.resume');
        return;
      case 'cancel':
        if (!this.busy) throw new ControlError('not_printing', 'Es läuft kein Druck');
        await this.client.request('printer.print.cancel');
        return;
      case 'emergency_stop':
        // Always allowed, even when Klipper is not "ready".
        await this.client.request('printer.emergency_stop');
        return;
      case 'firmware_restart':
        await this.client.request('printer.firmware_restart');
        return;
      case 'restart':
        await this.client.request('printer.restart');
        return;
    }
  }

  async setTemperature(heater: string, target: number): Promise<string> {
    const info = this.requireReady().heaters.find((h) => h.name === heater);
    if (!info) throw new ControlError('invalid', `Unbekannte Heizung: ${heater}`);
    if (target !== 0 && (target < info.minTemp || target > info.maxTemp)) {
      throw new ControlError('invalid', `${info.label}: erlaubt sind ${info.minTemp}–${info.maxTemp} °C (oder 0 = aus)`);
    }
    // SET_HEATER_TEMPERATURE takes the config section name without the "heater_generic " prefix.
    const name = heater.startsWith('heater_generic ') ? heater.slice('heater_generic '.length) : heater;
    return this.gcode(`SET_HEATER_TEMPERATURE HEATER=${name} TARGET=${round(target, 1)}`);
  }

  async home(axes: ('x' | 'y' | 'z')[]): Promise<string> {
    this.requireReady();
    this.requireIdle('Referenzfahrt');
    return this.gcode(axes.length ? `G28 ${axes.map((a) => a.toUpperCase()).join(' ')}` : 'G28');
  }

  async move(axis: 'x' | 'y' | 'z', distance: number, speed?: number): Promise<string> {
    this.requireReady();
    this.requireIdle('Bewegen');
    if (!this.status.homedAxes?.includes(axis)) {
      throw new ControlError('not_homed', `Achse ${axis.toUpperCase()} ist nicht referenziert`);
    }
    const feed = Math.round((speed ?? DEFAULT_SPEEDS[axis]) * 60);
    // Relative move, then back to absolute positioning so later G-code isn't affected.
    return this.gcode(`G91\nG1 ${axis.toUpperCase()}${round(distance, 3)} F${feed}\nG90`);
  }

  async speedFactor(percent: number): Promise<string> {
    this.requireReady();
    return this.gcode(`M220 S${percent}`);
  }

  async flowFactor(percent: number): Promise<string> {
    this.requireReady();
    return this.gcode(`M221 S${percent}`);
  }

  async fan(percent: number): Promise<string> {
    if (!this.requireReady().hasFan) throw new ControlError('invalid', 'Kein Bauteillüfter konfiguriert');
    return this.gcode(`M106 S${Math.round((percent / 100) * 255)}`);
  }

  async macro(name: string): Promise<string> {
    if (!this.requireReady().macros.includes(name)) throw new ControlError('invalid', `Unbekanntes Makro: ${name}`);
    return this.gcode(name);
  }

  async excludeObject(name: string): Promise<string> {
    const ex = this.status.excludeObject;
    if (!this.busy || !ex?.objects.some((o) => o.name === name)) {
      throw new ControlError('invalid', 'Objekt nicht im aktuellen Druck vorhanden');
    }
    if (ex.excluded.includes(name)) throw new ControlError('invalid', 'Objekt ist bereits ausgeschlossen');
    return this.gcode(`EXCLUDE_OBJECT NAME=${name}`);
  }

  async startPrint(path: string): Promise<void> {
    this.requireReady();
    this.requireIdle('Ein neuer Druck');
    await this.client.request('printer.print.start', { filename: path });
  }

  /** Raw console command. Returns the script that was sent. */
  async gcode(script: string): Promise<string> {
    await this.client.request('printer.gcode.script', { script });
    return script;
  }
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));
