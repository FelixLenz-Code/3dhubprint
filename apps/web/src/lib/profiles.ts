import { BED_TYPES, FALLBACK_BED_TYPE, type BedType, type PrinterProfileAssignment, type SlicerProfileInfo } from '@printhub/shared';

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

/** The plate a job uses unless chosen otherwise: printer setting, then the machine profile's default. */
export function effectiveBedType(assignment: PrinterProfileAssignment | undefined, machine: SlicerProfileInfo | undefined): BedType {
  const fromMachine = machine?.summary.defaultBedType;
  if (assignment?.bedType) return assignment.bedType;
  return typeof fromMachine === 'string' && fromMachine in BED_TYPES ? (fromMachine as BedType) : FALLBACK_BED_TYPE;
}

/** Bed temperature of a filament profile on a plate (undefined for profiles imported before plates were tracked). */
export function plateTemp(filament: SlicerProfileInfo, bedType: BedType): number | undefined {
  const v = filament.summary[BED_TYPES[bedType].temp];
  return typeof v === 'number' ? v : undefined;
}
