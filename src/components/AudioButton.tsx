import { useRef } from 'react'

export default function AudioButton({ label, src }: { label: string; src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null)

  function play() {
    if (!audioRef.current) return
    audioRef.current.currentTime = 0
    void audioRef.current.play().catch(() => {})
  }

  return (
    <button className="audio-btn" onClick={play} type="button" aria-label={`Play ${label} pronunciation`}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path d="M8 5v14l11-7z" />
      </svg>
      <span>{label}</span>
      <audio ref={audioRef} src={src} preload="none" />
    </button>
  )
}
