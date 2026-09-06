"use client";

import { useState } from "react";
import { SOUND_KEYS, SOUND_LABELS, setMuteAll, setSoundEnabled, useSoundSettings } from "@/lib/soundSettings";

export function SoundSettingsMenu() {
  const [open, setOpen] = useState(false);
  const settings = useSoundSettings();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="btn btn-secondary text-sm"
        aria-haspopup="true"
        aria-expanded={open}
      >
        {settings.muteAll ? "🔇" : "🔊"} Sounds
      </button>
      {open && (
        <>
          {/* Click-outside-to-close backdrop, below the panel but above everything else. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="card absolute right-0 z-20 mt-2 w-64 p-3">
            <label className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-sm font-bold text-brand-ink">
              <input type="checkbox" checked={settings.muteAll} onChange={(e) => setMuteAll(e.target.checked)} />
              Mute All
            </label>
            <div className="my-1.5 border-t border-line" />
            {SOUND_KEYS.map((key) => (
              <label
                key={key}
                className={`flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-sm text-ink-soft ${
                  settings.muteAll ? "opacity-50" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={settings.enabled[key]}
                  disabled={settings.muteAll}
                  onChange={(e) => setSoundEnabled(key, e.target.checked)}
                />
                {SOUND_LABELS[key]}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
