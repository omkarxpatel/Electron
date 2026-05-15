import { useEffect, useState, KeyboardEvent } from 'react';

interface Props {
  clientId: string | null;
  authed: boolean;
  authing: boolean;
  authError: string | null;
  saveClientId: (id: string) => void;
  connect: () => void;
}

export function SpotifyOnboarding({
  clientId,
  authed,
  authing,
  authError,
  saveClientId,
  connect,
}: Props) {
  const [input, setInput] = useState<string>('');

  useEffect(() => {
    setInput('');
  }, [clientId]);

  if (authed && clientId) {
    return null;
  }

  const handleSave = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    saveClientId(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSave();
    }
  };

  if (clientId === null) {
    const disabled = input.trim().length === 0;
    return (
      <div className="sp-onboarding">
        <div className="sp-onboarding-card">
          <h2 className="sp-onboarding-title">Connect your Spotify</h2>
          <ol className="sp-onboarding-steps">
            <li>
              Open developer.spotify.com/dashboard and either pick your existing app or create one.
            </li>
            <li>
              In Settings, add redirect URI{' '}
              <code className="sp-code">http://127.0.0.1:8888/callback</code> and check the Web API
              box.
            </li>
            <li>Copy the Client ID and paste it below.</li>
          </ol>
          <input
            className="sp-input"
            type="text"
            placeholder="Paste your Client ID here"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="sp-button sp-button-primary"
            onClick={handleSave}
            disabled={disabled}
          >
            Save Client ID
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sp-onboarding">
      <div className="sp-onboarding-card">
        <h2 className="sp-onboarding-title">One more step — authorize</h2>
        <p className="sp-onboarding-sub">
          Click below to open Spotify in your browser and grant access.
        </p>
        <button
          className="sp-button sp-button-primary"
          onClick={connect}
          disabled={authing}
        >
          Connect to Spotify
        </button>
        {authing && <div className="sp-onboarding-status">Waiting for browser…</div>}
        {authError && <div className="sp-error">{authError}</div>}
        <button
          className="sp-button sp-button-ghost"
          onClick={() => saveClientId('')}
        >
          Change Client ID
        </button>
      </div>
    </div>
  );
}
