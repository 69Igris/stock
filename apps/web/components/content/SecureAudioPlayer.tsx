"use client";

/**
 * Secure Audio Player Component
 *
 * Custom audio player with security features:
 * - Custom controls (no native download button)
 * - Streaming only via signed URLs
 * - Progress tracking for completion
 * - Playback speed controls
 * - No right-click download option
 * - Resume from last position
 */

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import Image from "next/image";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Loader2,
  RotateCcw,
  Repeat,
} from "lucide-react";
import { cn } from "@usemoney/ui";

// ============== TYPES ==============

export interface SecureAudioPlayerProps {
  /** Audio source URL (signed URL) */
  src: string;
  /** Audio title */
  title?: string;
  /** Audio artist/speaker */
  artist?: string;
  /** Cover image URL */
  coverImage?: string;
  /** Starting position in seconds */
  startPosition?: number;
  /** Callback with progress updates (seconds, percentage) */
  onProgress?: (currentTime: number, percentage: number) => void;
  /** Callback when audio completes */
  onComplete?: () => void;
  /** Callback when audio ends */
  onEnded?: () => void;
  /** Progress update interval in ms */
  progressInterval?: number;
  /** Completion threshold (0-1) */
  completionThreshold?: number;
  /** Additional CSS class */
  className?: string;
  /** Watermark text to display */
  watermarkText?: string;
  /** Auto-play on load */
  autoPlay?: boolean;
}

export interface SecureAudioPlayerRef {
  play: () => void;
  pause: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  setPlaybackRate: (rate: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  isPlaying: () => boolean;
}

// ============== PLAYBACK SPEEDS ==============

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// ============== COMPONENT ==============

export const SecureAudioPlayer = forwardRef<
  SecureAudioPlayerRef,
  SecureAudioPlayerProps
>(
  (
    {
      src,
      title,
      artist,
      coverImage,
      startPosition = 0,
      onProgress,
      onComplete,
      onEnded,
      progressInterval = 1000,
      completionThreshold = 0.9,
      className,
      watermarkText,
      autoPlay = false,
    },
    ref
  ) => {
    const audioRef = useRef<HTMLAudioElement>(null);
    const progressRef = useRef<HTMLDivElement>(null);
    const completionTriggeredRef = useRef(false);

    const [isPlaying, setIsPlaying] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [currentTime, setCurrentTime] = useState(startPosition);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [isLooping, setIsLooping] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [buffered, setBuffered] = useState(0);

    // ============== AUDIO CONTROLS ==============

    const play = useCallback(async () => {
      if (!audioRef.current) return;
      try {
        await audioRef.current.play();
        setIsPlaying(true);
      } catch (err) {
        console.error("Play error:", err);
      }
    }, []);

    const pause = useCallback(() => {
      if (!audioRef.current) return;
      audioRef.current.pause();
      setIsPlaying(false);
    }, []);

    const togglePlay = useCallback(() => {
      if (isPlaying) {
        pause();
      } else {
        play();
      }
    }, [isPlaying, play, pause]);

    const seek = useCallback(
      (time: number) => {
        if (!audioRef.current) return;
        audioRef.current.currentTime = Math.max(0, Math.min(time, duration));
      },
      [duration]
    );

    const skipForward = useCallback(() => {
      seek(currentTime + 10);
    }, [currentTime, seek]);

    const skipBackward = useCallback(() => {
      seek(currentTime - 10);
    }, [currentTime, seek]);

    const handleVolumeChange = useCallback((newVolume: number) => {
      if (!audioRef.current) return;
      const clampedVolume = Math.max(0, Math.min(1, newVolume));
      audioRef.current.volume = clampedVolume;
      setVolume(clampedVolume);
      setIsMuted(clampedVolume === 0);
    }, []);

    const toggleMute = useCallback(() => {
      if (!audioRef.current) return;
      if (isMuted) {
        audioRef.current.volume = volume || 1;
        setIsMuted(false);
      } else {
        audioRef.current.volume = 0;
        setIsMuted(true);
      }
    }, [isMuted, volume]);

    const handlePlaybackRateChange = useCallback((rate: number) => {
      if (!audioRef.current) return;
      audioRef.current.playbackRate = rate;
      setPlaybackRate(rate);
    }, []);

    const cyclePlaybackRate = useCallback(() => {
      const currentIndex = PLAYBACK_SPEEDS.indexOf(playbackRate);
      const nextIndex = (currentIndex + 1) % PLAYBACK_SPEEDS.length;
      handlePlaybackRateChange(PLAYBACK_SPEEDS[nextIndex]);
    }, [playbackRate, handlePlaybackRateChange]);

    const toggleLoop = useCallback(() => {
      if (!audioRef.current) return;
      audioRef.current.loop = !isLooping;
      setIsLooping(!isLooping);
    }, [isLooping]);

    // ============== PROGRESS BAR CLICK ==============

    const handleProgressClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (!progressRef.current || duration === 0) return;
        const rect = progressRef.current.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const percentage = clickX / rect.width;
        seek(percentage * duration);
      },
      [duration, seek]
    );

    // ============== AUDIO EVENT HANDLERS ==============

    useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;

      const handleLoadedMetadata = () => {
        setDuration(audio.duration);
        setIsLoading(false);
        if (startPosition > 0) {
          audio.currentTime = startPosition;
        }
        if (autoPlay) {
          play();
        }
      };

      const handleTimeUpdate = () => {
        const current = audio.currentTime;
        setCurrentTime(current);

        // Calculate progress percentage
        const percentage = duration > 0 ? (current / duration) * 100 : 0;
        onProgress?.(current, percentage);

        // Check for completion
        if (
          !completionTriggeredRef.current &&
          duration > 0 &&
          current / duration >= completionThreshold
        ) {
          completionTriggeredRef.current = true;
          onComplete?.();
        }
      };

      const handleProgress = () => {
        if (audio.buffered.length > 0) {
          const bufferedEnd = audio.buffered.end(audio.buffered.length - 1);
          setBuffered((bufferedEnd / duration) * 100);
        }
      };

      const handleEnded = () => {
        setIsPlaying(false);
        onEnded?.();
        if (!completionTriggeredRef.current) {
          completionTriggeredRef.current = true;
          onComplete?.();
        }
      };

      const handleError = () => {
        setError("Failed to load audio");
        setIsLoading(false);
      };

      const handleWaiting = () => setIsLoading(true);
      const handleCanPlay = () => setIsLoading(false);

      audio.addEventListener("loadedmetadata", handleLoadedMetadata);
      audio.addEventListener("timeupdate", handleTimeUpdate);
      audio.addEventListener("progress", handleProgress);
      audio.addEventListener("ended", handleEnded);
      audio.addEventListener("error", handleError);
      audio.addEventListener("waiting", handleWaiting);
      audio.addEventListener("canplay", handleCanPlay);

      return () => {
        audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
        audio.removeEventListener("timeupdate", handleTimeUpdate);
        audio.removeEventListener("progress", handleProgress);
        audio.removeEventListener("ended", handleEnded);
        audio.removeEventListener("error", handleError);
        audio.removeEventListener("waiting", handleWaiting);
        audio.removeEventListener("canplay", handleCanPlay);
      };
    }, [
      duration,
      startPosition,
      autoPlay,
      completionThreshold,
      onProgress,
      onComplete,
      onEnded,
      play,
    ]);

    // ============== KEYBOARD CONTROLS ==============

    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        // Only handle if this player is focused or no input is focused
        const activeElement = document.activeElement;
        if (
          activeElement?.tagName === "INPUT" ||
          activeElement?.tagName === "TEXTAREA"
        ) {
          return;
        }

        switch (e.key) {
          case " ":
            e.preventDefault();
            togglePlay();
            break;
          case "ArrowLeft":
            e.preventDefault();
            skipBackward();
            break;
          case "ArrowRight":
            e.preventDefault();
            skipForward();
            break;
          case "ArrowUp":
            e.preventDefault();
            handleVolumeChange(volume + 0.1);
            break;
          case "ArrowDown":
            e.preventDefault();
            handleVolumeChange(volume - 0.1);
            break;
          case "m":
            e.preventDefault();
            toggleMute();
            break;
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [
      togglePlay,
      skipBackward,
      skipForward,
      handleVolumeChange,
      volume,
      toggleMute,
    ]);

    // ============== EXPOSE METHODS ==============

    useImperativeHandle(ref, () => ({
      play,
      pause,
      seek,
      setVolume: handleVolumeChange,
      setPlaybackRate: handlePlaybackRateChange,
      getCurrentTime: () => currentTime,
      getDuration: () => duration,
      isPlaying: () => isPlaying,
    }));

    // ============== HELPERS ==============

    const formatTime = (seconds: number): string => {
      if (isNaN(seconds) || !isFinite(seconds)) return "0:00";
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    const progressPercentage =
      duration > 0 ? (currentTime / duration) * 100 : 0;

    // ============== RENDER ==============

    return (
      <div
        className={cn(
          "secure-audio-player relative bg-gray-900 rounded-lg p-4",
          className
        )}
        style={{
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Hidden Audio Element */}
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          crossOrigin="anonymous"
        />

        {/* Cover and Info */}
        <div className="flex items-center gap-4 mb-4">
          {/* Cover Image */}
          {coverImage && (
            <div className="relative w-16 h-16 rounded-lg overflow-hidden flex-shrink-0">
              <Image
                src={coverImage}
                alt={title || "Audio cover"}
                fill
                className="object-cover"
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                unoptimized
              />
              {watermarkText && (
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{
                    fontSize: "6px",
                    color: "rgba(255,255,255,0.1)",
                    transform: "rotate(-30deg)",
                  }}
                >
                  {watermarkText}
                </div>
              )}
            </div>
          )}

          {/* Title and Artist */}
          <div className="flex-1 min-w-0">
            {title && (
              <h3 className="text-foreground font-medium truncate">{title}</h3>
            )}
            {artist && (
              <p className="text-gray-400 text-sm truncate">{artist}</p>
            )}
          </div>

          {/* Loading/Error State */}
          {isLoading && (
            <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
          )}
        </div>

        {/* Error Message */}
        {error && (
          <div className="text-red-500 text-sm mb-4 text-center">{error}</div>
        )}

        {/* Progress Bar */}
        <div className="mb-4">
          <div
            ref={progressRef}
            className="relative h-2 bg-gray-700 rounded-full cursor-pointer overflow-hidden"
            onClick={handleProgressClick}
          >
            {/* Buffered */}
            <div
              className="absolute h-full bg-gray-600 rounded-full"
              style={{ width: `${buffered}%` }}
            />
            {/* Progress */}
            <div
              className="absolute h-full bg-blue-500 rounded-full transition-all duration-100"
              style={{ width: `${progressPercentage}%` }}
            />
            {/* Thumb */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-lg transition-all duration-100"
              style={{ left: `calc(${progressPercentage}% - 6px)` }}
            />
          </div>

          {/* Time Display */}
          <div className="flex justify-between mt-1 text-xs text-gray-400">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between">
          {/* Left Controls */}
          <div className="flex items-center gap-2">
            {/* Volume */}
            <button
              onClick={toggleMute}
              className="p-2 rounded-full hover:bg-gray-800 transition-colors"
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted ? (
                <VolumeX className="w-5 h-5 text-gray-400" />
              ) : (
                <Volume2 className="w-5 h-5 text-foreground" />
              )}
            </button>

            {/* Volume Slider */}
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={isMuted ? 0 : volume}
              onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
              className="w-20 h-1 bg-gray-700 rounded-full appearance-none cursor-pointer
                         [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3
                         [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full
                         [&::-webkit-slider-thumb]:bg-white"
            />
          </div>

          {/* Center Controls */}
          <div className="flex items-center gap-2">
            {/* Skip Backward */}
            <button
              onClick={skipBackward}
              className="p-2 rounded-full hover:bg-gray-800 transition-colors"
              title="Skip back 10s"
            >
              <SkipBack className="w-5 h-5 text-foreground" />
            </button>

            {/* Play/Pause */}
            <button
              onClick={togglePlay}
              disabled={!!error}
              className="p-3 rounded-full bg-white hover:bg-gray-200 disabled:opacity-50 transition-colors"
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <Pause className="w-6 h-6 text-gray-900" />
              ) : (
                <Play className="w-6 h-6 text-gray-900 ml-0.5" />
              )}
            </button>

            {/* Skip Forward */}
            <button
              onClick={skipForward}
              className="p-2 rounded-full hover:bg-gray-800 transition-colors"
              title="Skip forward 10s"
            >
              <SkipForward className="w-5 h-5 text-foreground" />
            </button>
          </div>

          {/* Right Controls */}
          <div className="flex items-center gap-2">
            {/* Playback Speed */}
            <button
              onClick={cyclePlaybackRate}
              className="px-2 py-1 text-xs font-medium text-foreground rounded hover:bg-gray-800 transition-colors min-w-[40px]"
              title="Playback speed"
            >
              {playbackRate}x
            </button>

            {/* Loop */}
            <button
              onClick={toggleLoop}
              className={cn(
                "p-2 rounded-full transition-colors",
                isLooping
                  ? "bg-blue-600 text-foreground"
                  : "hover:bg-gray-800 text-gray-400"
              )}
              title={isLooping ? "Loop on" : "Loop off"}
            >
              <Repeat className="w-4 h-4" />
            </button>

            {/* Restart */}
            <button
              onClick={() => seek(0)}
              className="p-2 rounded-full hover:bg-gray-800 transition-colors"
              title="Restart"
            >
              <RotateCcw className="w-4 h-4 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Security Styles */}
        <style jsx global>{`
          .secure-audio-player audio {
            display: none !important;
          }

          @media print {
            .secure-audio-player {
              display: none !important;
            }
          }
        `}</style>
      </div>
    );
  }
);

SecureAudioPlayer.displayName = "SecureAudioPlayer";

export default SecureAudioPlayer;
