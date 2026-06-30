// The seed: the dandelion mark inside a slowly spinning neuron ring with a soft
// gold pulse. The signature element of the app. Purely decorative; sizes scale
// the ring (the square) and the mark (the dandelion) independently.
export function BrandSeed({
  size = 300,
  mark = 88,
  className,
}: {
  size?: number
  mark?: number
  className?: string
}) {
  return (
    <div
      className={`mp-seed${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <span className="mp-seed__glow" />
      <span className="mp-seed__ring" />
      <span className="mp-seed__mark" style={{ width: mark, height: mark }} />
    </div>
  )
}
