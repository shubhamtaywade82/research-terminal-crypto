'use client';

// Chart components built on recharts for the NPRS research dashboard:
// equity curve, drawdown, and price series with trade markers.

import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtDateTime, fmtPrice, fmtUsd } from '@/lib/format';

const tooltipStyle = {
  backgroundColor: '#18181b',
  border: '1px solid #3f3f46',
  borderRadius: 8,
  fontSize: 12,
} as const;

function commonXAxis(tickCount = 6) {
  return (
    <XAxis
      dataKey="t"
      type="number"
      domain={['dataMin', 'dataMax']}
      tick={{ fill: '#71717a', fontSize: 11 }}
      tickFormatter={(t: number) => new Date(t).toISOString().slice(2, 10)}
      tickCount={tickCount}
      stroke="#3f3f46"
      minTickGap={48}
    />
  );
}

export function EquityChart({
  data,
  startEquity,
}: {
  data: { t: number; equity: number }[];
  startEquity: number;
}) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
          {commonXAxis()}
          <YAxis
            tick={{ fill: '#71717a', fontSize: 11 }}
            tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`}
            stroke="#3f3f46"
            width={58}
            domain={[0, 'auto']}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={{ color: '#a1a1aa' }}
            itemStyle={{ color: '#e4e4e7' }}
            labelFormatter={(t) => fmtDateTime(Number(t))}
            formatter={(v) => [fmtUsd(Number(v)), 'Equity']}
          />
          <ReferenceLine
            y={startEquity}
            stroke="#52525b"
            strokeDasharray="4 4"
            label={{ value: 'start', fill: '#71717a', fontSize: 10, position: 'insideTopLeft' }}
          />
          <Area
            type="monotone"
            dataKey="equity"
            stroke="#34d399"
            strokeWidth={1.5}
            fill="url(#equityFill)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DrawdownChart({ data }: { data: { t: number; drawdownPct: number }[] }) {
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.05} />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.28} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
          {commonXAxis()}
          <YAxis
            tick={{ fill: '#71717a', fontSize: 11 }}
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            stroke="#3f3f46"
            width={58}
            reversed
            domain={[0, 'auto']}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={{ color: '#a1a1aa' }}
            itemStyle={{ color: '#fda4af' }}
            labelFormatter={(t) => fmtDateTime(Number(t))}
            formatter={(v) => [`${Number(v).toFixed(2)}%`, 'Drawdown']}
          />
          <Area
            type="monotone"
            dataKey="drawdownPct"
            stroke="#f43f5e"
            strokeWidth={1.2}
            fill="url(#ddFill)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface PriceMarker {
  t: number;
  price: number;
}

export function PriceChart({
  series,
  entries,
  exitTp,
  exitLiq,
  exitOther,
}: {
  series: { t: number; c: number }[];
  entries: PriceMarker[];
  exitTp: PriceMarker[];
  exitLiq: PriceMarker[];
  exitOther: PriceMarker[];
}) {
  return (
    <div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
            {commonXAxis()}
            <YAxis
              tick={{ fill: '#71717a', fontSize: 11 }}
              tickFormatter={(v: number) => fmtPrice(v)}
              stroke="#3f3f46"
              width={70}
              domain={['auto', 'auto']}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={{ color: '#a1a1aa' }}
              itemStyle={{ color: '#e4e4e7' }}
              labelFormatter={(t) => fmtDateTime(Number(t))}
            />
            <Line
              type="monotone"
              dataKey="c"
              stroke="#a1a1aa"
              strokeWidth={1}
              dot={false}
              name="Close"
            />
            <Scatter data={entries} dataKey="price" fill="#34d399" shape="circle" name="Entry" />
            <Scatter data={exitTp} dataKey="price" fill="#10b981" shape="diamond" name="TP" />
            <Scatter data={exitLiq} dataKey="price" fill="#f43f5e" shape="cross" name="Liquidation" />
            <Scatter data={exitOther} dataKey="price" fill="#f59e0b" shape="square" name="Other exit" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> Entry (avg price)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rotate-45 bg-emerald-600" /> Take profit
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 bg-rose-500" /> Liquidation
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 bg-amber-500" /> Other exit
        </span>
      </div>
    </div>
  );
}
