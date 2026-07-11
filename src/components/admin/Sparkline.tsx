interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  color?: string
}

/** Dependency-free inline SVG sparkline — no chart library in this repo. */
export default function Sparkline({ values, width = 120, height = 28, color = 'var(--red)' }: SparklineProps) {
  if (values.length === 0) {
    return <span className="sparkline sparkline-empty">—</span>
  }
  if (values.length === 1) {
    return <span className="sparkline sparkline-empty">{Math.round(values[0])} ms</span>
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const step = width / (values.length - 1)
  const points = values
    .map((v, i) => {
      const x = i * step
      const y = height - ((v - min) / range) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
