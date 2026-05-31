import { useUpload } from "./hooks/useUpload";
import { UploadScreen } from "./components/UploadScreen";
import { ProcessingScreen } from "./components/ProcessingScreen";
import { ResultScreen } from "./components/ResultScreen";
import { ErrorScreen } from "./components/ErrorScreen";

export default function App() {
  const { state, upload, reset, complete } = useUpload();

  return (
    <div className="app">
      <main className="app__main">
        {state.status === "idle" && <UploadScreen onFile={upload} />}

        {(state.status === "resizing" ||
          state.status === "uploading" ||
          state.status === "processing" ||
          state.status === "ready") && (
          <ProcessingScreen
            stage={state.status === "ready" ? "processing" : state.status}
            progress={state.status === "uploading" ? state.progress : undefined}
            isReady={state.status === "ready"}
            onComplete={complete}
          />
        )}

        {state.status === "done" && (
          <ResultScreen
            stickerUrl={state.stickerUrl}
            remainingToday={state.remainingToday}
            onReset={reset}
          />
        )}

        {state.status === "error" && (
          <ErrorScreen message={state.message} onRetry={reset} />
        )}
      </main>

      <style>{`
        .app {
          min-height: 100dvh;
          display: flex;
          flex-direction: column;
        }

        .app__main {
          flex: 1;
          display: flex;
          flex-direction: column;
        }
      `}</style>
    </div>
  );
}
