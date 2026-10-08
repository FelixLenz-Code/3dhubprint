import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** clsx + tailwind-merge: later classes (e.g. a caller's px-0) override conflicting defaults. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import type { Tone } from '../lib/format';

export function Button({
  variant = 'primary',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-accent text-accent-ink hover:brightness-110',
        variant === 'secondary' && 'border border-border bg-surface-2 text-text hover:border-text-3',
        variant === 'ghost' && 'text-text-2 hover:bg-surface-2 hover:text-text',
        variant === 'danger' && 'bg-critical text-white hover:brightness-110',
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cn(
        'min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text placeholder:text-text-3',
        'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30',
        className,
      )}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-text-2">{label}</span>
      {children}
      {hint && <span className="block text-xs text-text-3">{hint}</span>}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-2xl border border-border bg-surface', className)}>{children}</div>;
}

const toneClass: Record<Tone, string> = {
  good: 'text-good bg-good/12',
  warning: 'text-warning bg-warning/12',
  critical: 'text-critical bg-critical/12',
  info: 'text-info bg-info/12',
  neutral: 'text-text-2 bg-surface-2',
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium', toneClass[tone])}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

export function Alert({ tone = 'critical', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div role="alert" className={clsx('rounded-lg px-3 py-2 text-sm', toneClass[tone])}>
      {children}
    </div>
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div
      className={cn('h-2 overflow-hidden rounded-full bg-surface-2', className)}
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${value * 100}%` }} />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-text-3', className)} />;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-text-3">{label}</div>
      <div className="tabular truncate text-sm font-semibold text-text">{value}</div>
      {sub && <div className="tabular truncate text-xs text-text-3">{sub}</div>}
    </div>
  );
}

export function Segmented<K extends string>({ value, onChange, options, label }: { value: K; onChange: (v: K) => void; options: Record<K, string>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full overflow-x-auto rounded-lg [scrollbar-width:none] border border-border bg-surface p-0.5">
      {(Object.keys(options) as K[]).map((k) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={clsx('min-h-8 whitespace-nowrap rounded-md px-2 text-sm sm:px-3', value === k ? 'bg-surface-2 font-medium text-text' : 'text-text-2 hover:text-text')}
        >
          {options[k]}
        </button>
      ))}
    </div>
  );
}

export function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="min-w-0 px-4 py-3">
      <div className="text-xs text-text-3">{label}</div>
      <div className="truncate text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-text-3">{sub}</div>}
    </Card>
  );
}
