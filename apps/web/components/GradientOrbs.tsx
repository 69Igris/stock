/**
 * Static CSS gradient orbs for visual depth on select authenticated pages.
 * Zero runtime cost - painted once by GPU, no animation loop.
 * Use instead of ParticleField on pages where users spend extended time.
 */
export function GradientOrbs() {
  return (
    <div
      className="fixed inset-0 pointer-events-none z-0 overflow-hidden"
      aria-hidden="true"
    >
      {/* Emerald orb - top left */}
      <div className="absolute top-[-10%] left-[-5%] w-[600px] h-[600px] bg-[radial-gradient(circle,rgba(52,211,153,0.15),transparent_60%)] blur-[80px]" />
      {/* Violet orb - mid right */}
      <div className="absolute top-[25%] right-[-5%] w-[500px] h-[500px] bg-[radial-gradient(circle,rgba(167,139,250,0.12),transparent_60%)] blur-[70px]" />
      {/* Blue orb - bottom center */}
      <div className="absolute bottom-[-10%] left-[25%] w-[450px] h-[450px] bg-[radial-gradient(circle,rgba(59,130,246,0.10),transparent_60%)] blur-[60px]" />
    </div>
  );
}
