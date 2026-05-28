interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
}

export function ErrorScreen({ message, onRetry }: ErrorScreenProps) {
  return (
    <div className="error-screen">
      <div className="error-screen__card">
        <div className="error-screen__icon">
          <span>!</span>
        </div>
        <h2 className="error-screen__title">Something went wrong</h2>
        <p className="error-screen__message">{message}</p>
        <button className="error-screen__retry-btn" onClick={onRetry}>
          Try again
        </button>
      </div>

      <style>{`
        .error-screen {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 32px 24px;
          animation: error-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }

        @keyframes error-in {
          from { opacity: 0; transform: scale(0.94); }
          to { opacity: 1; transform: scale(1); }
        }

        .error-screen__card {
          background: var(--color-bg-card);
          border-radius: var(--radius-xl);
          padding: 48px 36px;
          box-shadow: var(--shadow-lg);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
          width: 100%;
          max-width: 340px;
          text-align: center;
          border: 1.5px solid #FFE8E3;
        }

        .error-screen__icon {
          width: 64px;
          height: 64px;
          background: #FFF0ED;
          border-radius: var(--radius-lg);
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: var(--font-display);
          font-size: 28px;
          font-weight: 800;
          color: var(--color-accent);
          margin-bottom: 4px;
        }

        .error-screen__title {
          font-family: var(--font-display);
          font-size: 20px;
          font-weight: 700;
          color: var(--color-ink);
          letter-spacing: -0.3px;
        }

        .error-screen__message {
          font-size: 14px;
          color: var(--color-ink-secondary);
          line-height: 1.5;
          max-width: 240px;
        }

        .error-screen__retry-btn {
          margin-top: 8px;
          padding: 13px 32px;
          background: var(--color-accent);
          color: white;
          border-radius: var(--radius-full);
          font-family: var(--font-display);
          font-size: 15px;
          font-weight: 600;
          letter-spacing: -0.2px;
          transition: all var(--transition-spring);
          box-shadow: var(--shadow-accent);
        }

        .error-screen__retry-btn:hover {
          background: var(--color-accent-hover);
          transform: translateY(-2px);
        }

        .error-screen__retry-btn:active {
          transform: scale(0.97);
        }
      `}</style>
    </div>
  );
}
