import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type Tone = 'default' | 'positive' | 'negative' | 'warning';

const toneClass: Record<Tone, string> = {
  default: 'text-zinc-100',
  positive: 'text-emerald-400',
  negative: 'text-rose-400',
  warning: 'text-amber-400',
};

interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}

export function MetricCard({ label, value, hint, tone = 'default' }: MetricCardProps) {
  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardContent className="p-4">
        <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
        <p className={cn('mt-1 font-mono text-lg font-semibold leading-tight', toneClass[tone])}>
          {value}
        </p>
        {hint ? <p className="mt-0.5 text-[11px] leading-snug text-zinc-600">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
