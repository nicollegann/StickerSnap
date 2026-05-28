interface ProcessingScreenProps {
  stage: 'resizing' | 'uploading' | 'processing';
  progress?: number;
}

const STAGE_MESSAGES = {
  resizing: { title: 'Preparing image…', sub: 'Optimising for processing' },
  uploading: { title: 'Uploading…', sub: 'Sending to the cloud' },
  processing: { title: 'Making your sticker…', sub: 'Removing background & adding border' },
};

export function ProcessingScreen({ stage, progress }: ProcessingScreenProps) {
  const { title, sub } = STAGE_MESSAGES[stage];

  return (
    <div className="processing-screen">
      <div className="processing-screen__card">
        <div className="processing-screen__animation">
          {/* Orbiting dots */}
          <div className="processing-screen__orbit">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className="processing-screen__dot"
                style={{ '--delay': `${i * 0.2}s` } as React.CSSProperties}
              />
            ))}
          </div>
          {/* Center icon */}
          <div className="processing-screen__center">
            <span>✦</span>
          </div>
        </div>

        <div className="processing-screen__text">
          <h2 className="processing-screen__title">{title}</h2>
          <p className="processing-screen__sub">{sub}</p>
        </div>

        {stage === 'uploading' && progress !== undefined && (
          <div className="processing-screen__progress">
            <div className="processing-screen__progress-track">
              <div
                className="processing-screen__progress-fill"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="processing-screen__progress-label">{progress}%</span>
          </div>
        )}

        {stage === 'processing' && (
          <div className="processing-screen__steps">
            {['Background removal', 'Adding sticker border', 'Finalising'].map((step, i) => (
              <div key={step} className="processing-screen__step" style={{ '--delay': `${i * 0.6}s` } as React.CSSProperties}>
                <span className="processing-screen__step-dot" />
                <span className="processing-screen__step-label">{step}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`
        .processing-screen {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 32px 24px;
        }

        .processing-screen__card {
          background: var(--color-bg-card);
          border-radius: var(--radius-xl);
          padding: 48px 40px;
          box-shadow: var(--shadow-lg);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 28px;
          width: 100%;
          max-width: 340px;
          animation: card-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }

        @keyframes card-in {
          from { opacity: 0; transform: translateY(20px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        .processing-screen__animation {
          width: 96px;
          height: 96px;
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .processing-screen__orbit {
          position: absolute;
          inset: 0;
          animation: orbit-spin 2s linear infinite;
        }

        @keyframes orbit-spin {
          to { transform: rotate(360deg); }
        }

        .processing-screen__dot {
          position: absolute;
          width: 8px;
          height: 8px;
          background: var(--color-accent);
          border-radius: 50%;
          animation: dot-pulse 1.6s ease-in-out infinite;
          animation-delay: var(--delay);
        }

        .processing-screen__dot:nth-child(1) { top: 0; left: 50%; transform: translateX(-50%); }
        .processing-screen__dot:nth-child(2) { right: 0; top: 50%; transform: translateY(-50%); }
        .processing-screen__dot:nth-child(3) { bottom: 0; left: 50%; transform: translateX(-50%); }
        .processing-screen__dot:nth-child(4) { left: 0; top: 50%; transform: translateY(-50%); }

        @keyframes dot-pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8) translateX(-50%); }
          50% { opacity: 1; transform: scale(1.2) translateX(-50%); }
        }

        /* Reset transforms for non-top dots */
        .processing-screen__dot:nth-child(2) { animation-name: dot-pulse-side; }
        .processing-screen__dot:nth-child(3) { animation-name: dot-pulse-bottom; }
        .processing-screen__dot:nth-child(4) { animation-name: dot-pulse-side; }

        @keyframes dot-pulse-side {
          0%, 100% { opacity: 0.3; transform: scale(0.8) translateY(-50%); }
          50% { opacity: 1; transform: scale(1.2) translateY(-50%); }
        }

        @keyframes dot-pulse-bottom {
          0%, 100% { opacity: 0.3; transform: scale(0.8) translateX(-50%); }
          50% { opacity: 1; transform: scale(1.2) translateX(-50%); }
        }

        .processing-screen__center {
          width: 52px;
          height: 52px;
          background: var(--color-accent-light);
          border-radius: var(--radius-md);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 22px;
          color: var(--color-accent);
          animation: center-breathe 2s ease-in-out infinite;
          z-index: 1;
        }

        @keyframes center-breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.06); }
        }

        .processing-screen__text { text-align: center; }

        .processing-screen__title {
          font-family: var(--font-display);
          font-size: 20px;
          font-weight: 700;
          color: var(--color-ink);
          margin-bottom: 6px;
          letter-spacing: -0.3px;
        }

        .processing-screen__sub {
          font-size: 13px;
          color: var(--color-ink-secondary);
        }

        /* Progress bar */
        .processing-screen__progress {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .processing-screen__progress-track {
          flex: 1;
          height: 6px;
          background: var(--color-bg-subtle);
          border-radius: var(--radius-full);
          overflow: hidden;
        }

        .processing-screen__progress-fill {
          height: 100%;
          background: var(--color-accent);
          border-radius: var(--radius-full);
          transition: width 0.3s ease;
        }

        .processing-screen__progress-label {
          font-size: 12px;
          font-weight: 500;
          color: var(--color-ink-secondary);
          min-width: 30px;
          text-align: right;
        }

        /* Steps */
        .processing-screen__steps {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .processing-screen__step {
          display: flex;
          align-items: center;
          gap: 10px;
          animation: step-in 0.4s ease both;
          animation-delay: var(--delay);
        }

        @keyframes step-in {
          from { opacity: 0; transform: translateX(-8px); }
          to { opacity: 1; transform: translateX(0); }
        }

        .processing-screen__step-dot {
          width: 6px;
          height: 6px;
          background: var(--color-accent);
          border-radius: 50%;
          flex-shrink: 0;
          animation: dot-blink 1.2s ease-in-out infinite;
          animation-delay: var(--delay);
        }

        @keyframes dot-blink {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }

        .processing-screen__step-label {
          font-size: 13px;
          color: var(--color-ink-secondary);
        }
      `}</style>
    </div>
  );
}
