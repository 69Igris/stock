"use client";

/**
 * Secure Video Player Component
 *
 * HLS-based video player with security features:
 * - Adaptive bitrate streaming (no full video download)
 * - Disabled download button
 * - Disabled right-click context menu
 * - Watermark overlay with user info
 * - Visibility-based pause/play
 * - Progress tracking
 */

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import Hls from "hls.js";
import { useScreenProtection, ProtectedMedia } from "../security";

// ============== TYPES ==============

export interface SecureVideoPlayerProps {
  /** HLS manifest URL (signed URL) */
  src: string;
  /** Video poster image URL */
  poster?: string;
  /** Video title for accessibility */
  title?: string;
  /** Callback when progress changes */
  onProgress?: (
    progress: number,
    currentTime: number,
    duration: number
  ) => void;
  /** Callback when video completes */
  onComplete?: () => void;
  /** Callback when video starts playing */
  onPlay?: () => void;
  /** Callback when video pauses */
  onPause?: () => void;
  /** Callback on error */
  onError?: (error: string) => void;
  /** Initial position in seconds */
  startPosition?: number;
  /** Auto-play (muted for browser policies) */
  autoPlay?: boolean;
  /** Custom className */
  className?: string;
  /** Show controls */
  showControls?: boolean;
  /** Watermark text (defaults to user email from context) */
  watermarkText?: string;
}

export interface SecureVideoPlayerRef {
  play: () => void;
  pause: () => void;
  seek: (time: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  setVolume: (volume: number) => void;
  setPlaybackRate: (rate: number) => void;
}

// ============== COMPONENT ==============

export const SecureVideoPlayer = forwardRef<
  SecureVideoPlayerRef,
  SecureVideoPlayerProps
>(function SecureVideoPlayer(
  {
    src,
    poster,
    title,
    onProgress,
    onComplete,
    onPlay,
    onPause,
    onError,
    startPosition = 0,
    autoPlay = false,
    className = "",
    showControls = true,
    watermarkText: customWatermark,
  },
  ref
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(autoPlay);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);
  const [playbackRate, setPlaybackRateState] = useState(1);

  const { isContentBlurred, watermarkText: contextWatermark } =
    useScreenProtection();
  const watermarkText = customWatermark || contextWatermark;

  // ============== IMPERATIVE HANDLE ==============

  useImperativeHandle(ref, () => ({
    play: () => videoRef.current?.play(),
    pause: () => videoRef.current?.pause(),
    seek: (time: number) => {
      if (videoRef.current) {
        videoRef.current.currentTime = time;
      }
    },
    getCurrentTime: () => videoRef.current?.currentTime || 0,
    getDuration: () => videoRef.current?.duration || 0,
    setVolume: (vol: number) => {
      if (videoRef.current) {
        videoRef.current.volume = Math.max(0, Math.min(1, vol));
        setVolume(vol);
      }
    },
    setPlaybackRate: (rate: number) => {
      if (videoRef.current) {
        videoRef.current.playbackRate = rate;
        setPlaybackRateState(rate);
      }
    },
  }));

  // ============== HLS INITIALIZATION ==============

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    const initHls = () => {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
          // Security: Don't cache segments for too long
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
        });

        hls.loadSource(src);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setIsLoading(false);
          if (startPosition > 0) {
            video.currentTime = startPosition;
          }
          if (autoPlay) {
            video.play().catch(() => {
              // Auto-play failed, likely need user interaction
              setIsMuted(true);
            });
          }
        });

        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                setError("Network error - please check your connection");
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                setError("Media error - trying to recover");
                hls.recoverMediaError();
                break;
              default:
                setError("An error occurred while loading the video");
                hls.destroy();
                break;
            }
            onError?.(data.details);
          }
        });

        hlsRef.current = hls;
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Native HLS support (Safari)
        video.src = src;
        video.addEventListener("loadedmetadata", () => {
          setIsLoading(false);
          if (startPosition > 0) {
            video.currentTime = startPosition;
          }
        });
      } else {
        setError("HLS is not supported in this browser");
        onError?.("HLS not supported");
      }
    };

    initHls();

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [src, startPosition, autoPlay, onError]);

  // ============== VISIBILITY PAUSE ==============

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isContentBlurred && isPlaying) {
      video.pause();
    }
  }, [isContentBlurred, isPlaying]);

  // ============== EVENT HANDLERS ==============

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    setCurrentTime(video.currentTime);

    if (video.duration > 0) {
      const progress = (video.currentTime / video.duration) * 100;
      onProgress?.(progress, video.currentTime, video.duration);
    }
  }, [onProgress]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      setDuration(video.duration);
    }
  }, []);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    onComplete?.();
  }, [onComplete]);

  const handlePlay = useCallback(() => {
    setIsPlaying(true);
    setShowOverlay(false);
    onPlay?.();
  }, [onPlay]);

  const handlePause = useCallback(() => {
    setIsPlaying(false);
    onPause?.();
  }, [onPause]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.pause();
    } else {
      video.play().catch(() => {
        setIsMuted(true);
        video.muted = true;
        video.play();
      });
    }
  }, [isPlaying]);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const video = videoRef.current;
      if (!video) return;

      const time = (parseFloat(e.target.value) / 100) * duration;
      video.currentTime = time;
      setCurrentTime(time);
    },
    [duration]
  );

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const video = videoRef.current;
      if (!video) return;

      const newVolume = parseFloat(e.target.value);
      video.volume = newVolume;
      setVolume(newVolume);
      setIsMuted(newVolume === 0);
    },
    []
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = !isMuted;
    setIsMuted(!isMuted);
  }, [isMuted]);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!document.fullscreenElement) {
      container.requestFullscreen?.();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.();
      setIsFullscreen(false);
    }
  }, []);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // ============== RENDER ==============

  return (
    <ProtectedMedia className={className}>
      <div
        ref={containerRef}
        className="relative w-full bg-black rounded-lg overflow-hidden group"
        style={{ aspectRatio: "16/9" }}
      >
        {/* Video Element */}
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          poster={poster}
          playsInline
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={handleEnded}
          onPlay={handlePlay}
          onPause={handlePause}
          onContextMenu={(e) => e.preventDefault()}
          controlsList="nodownload noremoteplayback"
          disablePictureInPicture
          style={{ pointerEvents: "none" }}
          aria-label={title}
        />

        {/* Click overlay for play/pause */}
        <div
          className="absolute inset-0 cursor-pointer"
          onClick={togglePlay}
          onDoubleClick={toggleFullscreen}
        />

        {/* Loading indicator */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin" />
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80">
            <div className="text-foreground text-center p-4">
              <p className="text-red-400 mb-2">Error</p>
              <p className="text-sm">{error}</p>
            </div>
          </div>
        )}

        {/* Play overlay (initial state) */}
        {showOverlay && !isLoading && !error && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/30 cursor-pointer"
            onClick={togglePlay}
          >
            <div className="w-20 h-20 flex items-center justify-center bg-white/20 rounded-full backdrop-blur-sm">
              <svg
                className="w-10 h-10 text-white ml-1"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}

        {/* Custom controls */}
        {showControls && !isLoading && !error && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 opacity-0 group-hover:opacity-100 transition-opacity">
            {/* Progress bar */}
            <input
              type="range"
              min="0"
              max="100"
              value={duration > 0 ? (currentTime / duration) * 100 : 0}
              onChange={handleSeek}
              className="w-full h-1 bg-white/30 rounded-full appearance-none cursor-pointer mb-3"
              style={{
                background: `linear-gradient(to right, #3b82f6 ${(currentTime / duration) * 100}%, rgba(255,255,255,0.3) ${(currentTime / duration) * 100}%)`,
              }}
            />

            <div className="flex items-center justify-between text-foreground">
              <div className="flex items-center gap-4">
                {/* Play/Pause button */}
                <button
                  onClick={togglePlay}
                  className="p-1 hover:bg-white/20 rounded transition-colors"
                  aria-label={isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? (
                    <svg
                      className="w-6 h-6"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
                    </svg>
                  ) : (
                    <svg
                      className="w-6 h-6"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>

                {/* Volume control */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={toggleMute}
                    className="p-1 hover:bg-white/20 rounded transition-colors"
                    aria-label={isMuted ? "Unmute" : "Mute"}
                  >
                    {isMuted || volume === 0 ? (
                      <svg
                        className="w-5 h-5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                      </svg>
                    ) : (
                      <svg
                        className="w-5 h-5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                      </svg>
                    )}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    className="w-16 h-1 bg-white/30 rounded-full appearance-none cursor-pointer"
                  />
                </div>

                {/* Time display */}
                <span className="text-sm font-mono">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
              </div>

              <div className="flex items-center gap-2">
                {/* Playback speed */}
                <select
                  value={playbackRate}
                  onChange={(e) => {
                    const rate = parseFloat(e.target.value);
                    if (videoRef.current) {
                      videoRef.current.playbackRate = rate;
                      setPlaybackRateState(rate);
                    }
                  }}
                  className="bg-transparent text-foreground text-sm border border-white/30 rounded px-2 py-1"
                >
                  <option value="0.5">0.5x</option>
                  <option value="0.75">0.75x</option>
                  <option value="1">1x</option>
                  <option value="1.25">1.25x</option>
                  <option value="1.5">1.5x</option>
                  <option value="2">2x</option>
                </select>

                {/* Fullscreen button */}
                <button
                  onClick={toggleFullscreen}
                  className="p-1 hover:bg-white/20 rounded transition-colors"
                  aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                  {isFullscreen ? (
                    <svg
                      className="w-5 h-5"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                    </svg>
                  ) : (
                    <svg
                      className="w-5 h-5"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Watermark */}
        {watermarkText && (
          <div
            className="absolute top-4 right-4 text-white/20 text-xs font-mono pointer-events-none select-none"
            style={{ textShadow: "0 0 2px rgba(0,0,0,0.5)" }}
          >
            {watermarkText}
          </div>
        )}
      </div>
    </ProtectedMedia>
  );
});

export default SecureVideoPlayer;
