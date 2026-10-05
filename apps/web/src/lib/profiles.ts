import type { PrinterProfileAssignment, SlicerProfileInfo } from '@printhub/shared';

/** Mirrors the server rule: empty compatible_printers = universal. */
export function isCompatible(p: SlicerProfileInfo, machine: SlicerProfileInfo | undefined): boolean {
  if (!machine) return false;
  return !p.compatiblePrinters.length || p.compatiblePrinters.includes(machine.name) || (!!machine.systemPrinter && p.compatiblePrinters.includes(machine.systemPrinter));
}

/** Profiles a printer may use: the explicit allow-list, or else every compatible one. */
export function allowedProfiles(
  kind: 'process' | 'filament',
  profiles: SlicerProfileInfo[],
  assignment: PrinterProfileAssignment | undefined,
): SlicerProfileInfo[] {
  const machine = profiles.find((p) => p.kind === 'machine' && p.name === assignment?.machine);
  const list = assignment?.[kind] ?? [];
  return profiles.filter((p) => p.kind === kind && (list.length ? list.includes(p.name) : isCompatible(p, machine)));
}
