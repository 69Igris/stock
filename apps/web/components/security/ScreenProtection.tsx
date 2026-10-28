"use client";

/**
 * Screen Protection Component
 *
 * Provides DRM-like protection for premium content:
 * - Anti-screenshot (CSS-based, with detection)
 * - Anti-download (no context menu, disabled drag)
 * - Anti-screen recording detection
 * - DevTools detection
 * - Watermarking support
 *
 * Limitations: Browser-based DRM has inherent limits.
 * This deters casual copying but cannot prevent determined users.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { useUser } from "@clerk/nextjs";

// ============== TYPES ==============

interface ScreenProtectionContextType {
  isProtected: boolean;
  isContentBlurred: boolean;
  isDevToolsOpen: boolean;
  isScreenRecording: boolean;
  watermarkText: string;
  pauseContent: () => void;
  resumeContent: () => void;
}

interface ScreenProtectionProviderProps {
  children: ReactNode;
  enabled?: boolean;
  blurOnDevTools?: boolean;
  blurOnHidden?: boolean;
  detectScreenRecording?: boolean;
  watermarkEnabled?: boolean;
  onSecurityViolation?: (type: string) => void;
}

// ============== CONTEXT ==============

const ScreenProtectionContext = createContext<ScreenProtectionContextType>({
  isProtected: false,
  isContentBlurred: false,
  isDevToolsOpen: false,
  isScreenRecording: false,
  watermarkText: "",
  pauseContent: () => {},
  resumeContent: () => {},
});

export const useScreenProtection = () => useContext(ScreenProtectionContext);

// ============== PROVIDER ==============

export function ScreenProtectionProvider({
  children,
  enabled = true,
  blurOnDevTools = true,
  blurOnHidden = true,
  detectScreenRecording = true,
  watermarkEnabled = true,
  onSecurityViolation,
}: ScreenProtectionProviderProps) {
  const { user } = useUser();
  const [isContentBlurred, setIsContentBlurred] = useState(false);
  const [isDevToolsOpen, setIsDevToolsOpen] = useState(false);
  const [isScreenRecording, setIsScreenRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  // Generate watermark text with user info
  const watermarkText =
    watermarkEnabled && user
      ? `${user.primaryEmailAddress?.emailAddress || user.id} - ${new Date().toISOString().split("T")[0]}`
      : "";

  // ============== KEYBOARD SHORTCUTS PREVENTION ==============

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent PrintScreen
      if (e.key === "PrintScreen") {
        e.preventDefault();
        setIsContentBlurred(true);
        onSecurityViolation?.("printscreen");

        // Unblur after a short delay
        setTimeout(() => setIsContentBlurred(false), 2000);
      }

      // Prevent Ctrl+P (Print)
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        onSecurityViolation?.("print");
      }

      // Prevent Ctrl+S (Save)
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        onSecurityViolation?.("save");
      }

      // Detect Ctrl+Shift+I (DevTools)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "I") {
        onSecurityViolation?.("devtools_shortcut");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onSecurityViolation]);

  // ============== CONTEXT MENU PREVENTION ==============

  useEffect(() => {
    if (!enabled) return;

    const handleContextMenu = (e: MouseEvent) => {
      // Allow context menu on form elements
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      e.preventDefault();
      onSecurityViolation?.("context_menu");
    };

    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, [enabled, onSecurityViolation]);

  // ============== VISIBILITY CHANGE DETECTION ==============

  useEffect(() => {
    if (!enabled || !blurOnHidden) return;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        setIsContentBlurred(true);
        setIsPaused(true);
      } else {
        setIsContentBlurred(false);
        setIsPaused(false);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [enabled, blurOnHidden]);

  // ============== DEVTOOLS DETECTION ==============

  useEffect(() => {
    if (!enabled || !blurOnDevTools) return;

    let devToolsOpen = false;

    // Method 1: Window size detection (less reliable but works for docked DevTools)
    const checkWindowSize = () => {
      const widthThreshold = window.outerWidth - window.innerWidth > 160;
      const heightThreshold = window.outerHeight - window.innerHeight > 160;

      if (widthThreshold || heightThreshold) {
        if (!devToolsOpen) {
          devToolsOpen = true;
          setIsDevToolsOpen(true);
          setIsContentBlurred(true);
          onSecurityViolation?.("devtools_detected");
        }
      } else {
        if (devToolsOpen) {
          devToolsOpen = false;
          setIsDevToolsOpen(false);
          setIsContentBlurred(false);
        }
      }
    };

    // Method 2: Console.log timing detection
    const detectDevToolsWithConsole = () => {
      const element = new Image();
      let isOpen = false;

      Object.defineProperty(element, "id", {
        get: function () {
          isOpen = true;
          if (!devToolsOpen) {
            devToolsOpen = true;
            setIsDevToolsOpen(true);
            setIsContentBlurred(true);
            onSecurityViolation?.("devtools_console");
          }
        },
      });

      // This triggers when DevTools is open and inspecting
      console.debug(element);

      if (!isOpen && devToolsOpen) {
        devToolsOpen = false;
        setIsDevToolsOpen(false);
        setIsContentBlurred(false);
      }
    };

    // Check periodically
    const intervalId = setInterval(() => {
      checkWindowSize();
      detectDevToolsWithConsole();
    }, 1000);

    return () => clearInterval(intervalId);
  }, [enabled, blurOnDevTools, onSecurityViolation]);

  // ============== SCREEN RECORDING DETECTION ==============

  useEffect(() => {
    if (!enabled || !detectScreenRecording) return;

    // Monitor for getDisplayMedia calls
    const originalGetDisplayMedia = navigator.mediaDevices?.getDisplayMedia;

    if (originalGetDisplayMedia) {
      navigator.mediaDevices.getDisplayMedia = async function (...args) {
        setIsScreenRecording(true);
        onSecurityViolation?.("screen_recording");

        // Still allow the call but mark as recording
        try {
          const stream = await originalGetDisplayMedia.apply(this, args);

          // Listen for track end to detect when recording stops
          stream.getTracks().forEach((track) => {
            track.addEventListener("ended", () => {
              setIsScreenRecording(false);
            });
          });

          return stream;
        } catch (error) {
          setIsScreenRecording(false);
          throw error;
        }
      };
    }

    return () => {
      if (originalGetDisplayMedia) {
        navigator.mediaDevices.getDisplayMedia = originalGetDisplayMedia;
      }
    };
  }, [enabled, detectScreenRecording, onSecurityViolation]);

  // ============== PAUSE/RESUME CONTROLS ==============

  const pauseContent = useCallback(() => {
    setIsPaused(true);
    setIsContentBlurred(true);
  }, []);

  const resumeContent = useCallback(() => {
    setIsPaused(false);
    setIsContentBlurred(false);
  }, []);

  // ============== RENDER ==============

  return (
    <ScreenProtectionContext.Provider
      value={{
        isProtected: enabled,
        isContentBlurred: enabled && isContentBlurred,
        isDevToolsOpen,
        isScreenRecording,
        watermarkText,
        pauseContent,
        resumeContent,
      }}
    >
      {enabled ? (
        <ProtectedContainer
          isBlurred={isContentBlurred}
          watermarkText={watermarkText}
          watermarkEnabled={watermarkEnabled}
          isPaused={isPaused}
        >
          {children}
        </ProtectedContainer>
      ) : (
        children
      )}
    </ScreenProtectionContext.Provider>
  );
}

// ============== PROTECTED CONTAINER ==============

interface ProtectedContainerProps {
  children: ReactNode;
  isBlurred: boolean;
  watermarkText: string;
  watermarkEnabled: boolean;
  isPaused: boolean;
}

function ProtectedContainer({
  children,
  isBlurred,
  watermarkText,
  watermarkEnabled,
  isPaused,
}: ProtectedContainerProps) {
  return (
    <div
      className="protected-content"
      style={
        {
          position: "relative",
          userSelect: "none",
          WebkitUserSelect: "none",
          MozUserSelect: "none",
          msUserSelect: "none",
        } as React.CSSProperties
      }
      onDragStart={(e) => e.preventDefault()}
      onCopy={(e) => e.preventDefault()}
    >
      {/* Main content with blur effect */}
      <div
        style={{
          filter: isBlurred ? "blur(20px)" : "none",
          transition: "filter 0.3s ease",
          pointerEvents: isBlurred ? "none" : "auto",
        }}
      >
        {children}
      </div>

      {/* Blur overlay message */}
      {isBlurred && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.7)",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              backgroundColor: "white",
              padding: "24px 32px",
              borderRadius: "12px",
              textAlign: "center",
              maxWidth: "400px",
            }}
          >
            <h3
              style={{ margin: "0 0 12px", fontSize: "18px", fontWeight: 600 }}
            >
              Content Protected
            </h3>
            <p style={{ margin: 0, color: "#666", fontSize: "14px" }}>
              {isPaused
                ? "Content is paused. Return to continue viewing."
                : "Please close developer tools to view this content."}
            </p>
          </div>
        </div>
      )}

      {/* Watermark overlay */}
      {watermarkEnabled && watermarkText && !isBlurred && (
        <Watermark text={watermarkText} />
      )}

      {/* Print protection styles */}
      <style jsx global>{`
        @media print {
          .protected-content {
            display: none !important;
          }
          body::before {
            content: "Content printing is not allowed.";
            display: block;
            font-size: 24px;
            text-align: center;
            padding: 100px;
          }
        }

        /* Prevent image dragging */
        .protected-content img {
          -webkit-user-drag: none;
          user-drag: none;
          pointer-events: none;
        }

        /* Prevent video controls right-click */
        .protected-content video::-webkit-media-controls-enclosure {
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}

// ============== WATERMARK COMPONENT ==============

interface WatermarkProps {
  text: string;
}

function Watermark({ text }: WatermarkProps) {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: "none",
        zIndex: 9998,
        overflow: "hidden",
      }}
      aria-hidden="true"
    >
      {/* Generate multiple watermarks in a diagonal pattern */}
      {Array.from({ length: 20 }).map((_, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            top: `${(i * 15) % 100}%`,
            left: `${(i * 23) % 100}%`,
            transform: "rotate(-30deg)",
            opacity: 0.03,
            fontSize: "14px",
            fontFamily: "monospace",
            whiteSpace: "nowrap",
            color: "#000",
            userSelect: "none",
          }}
        >
          {text}
        </div>
      ))}
    </div>
  );
}

// ============== PROTECTED MEDIA WRAPPER ==============

interface ProtectedMediaProps {
  children: ReactNode;
  className?: string;
}

/**
 * Wrapper for media elements (video, audio, images) with extra protection
 */
export function ProtectedMedia({ children, className }: ProtectedMediaProps) {
  const { isContentBlurred, pauseContent, resumeContent } =
    useScreenProtection();

  useEffect(() => {
    // Pause content when blurred
    if (isContentBlurred) {
      pauseContent();
    } else {
      resumeContent();
    }
  }, [isContentBlurred, pauseContent, resumeContent]);

  return (
    <div
      className={className}
      style={{
        position: "relative",
        userSelect: "none",
      }}
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}

// ============== EXPORTS ==============

export { ScreenProtectionContext };
export type { ScreenProtectionContextType, ScreenProtectionProviderProps };
