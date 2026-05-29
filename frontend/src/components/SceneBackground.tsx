export function SceneBackground() {
  return (
    <div className="scene-bg" aria-hidden="true">
      {/* Grid notepad layer */}
      <div className="scene-bg__grid" />

      {/* Shapes PNG overlay — use the background_shapes.png asset */}
      <div className="scene-bg__shapes" />

      <style>{`
        .scene-bg {
          position: fixed;
          inset: 0;
          z-index: 0;
          overflow: hidden;
          /* Warm off-white notepad base */
          background-color: #f5f2ed;
          pointer-events: none;
        }

        /* Fine grid lines — matches the reference image's soft grid paper */
        .scene-bg__grid {
          position: absolute;
          inset: 0;
          background-image:
            /* Horizontal lines */
            linear-gradient(
              to bottom,
              rgba(180, 170, 155, 0.35) 1px,
              transparent 1px
            ),
            /* Vertical lines */
            linear-gradient(
              to right,
              rgba(180, 170, 155, 0.35) 1px,
              transparent 1px
            );
          background-size: 28px 28px;
        }

        /* Shapes overlay — background_shapes.png, covers the full viewport */
        .scene-bg__shapes {
          position: absolute;
          inset: 0;
          background-image: url('assets/background_shapes.png');
          background-size: 1000px;
          background-position: center;
          background-repeat: no-repeat;
          /* The PNG has a black bg — multiply blends it away, leaving only the shapes */
          mix-blend-mode: multiply;
          opacity: 1;
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}
