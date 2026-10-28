/**
 * Content Components
 *
 * Shared components for the content management system including:
 * - Secure media players (video, audio, document)
 * - Content gating (premium paywall)
 * - SEO structured data
 * - Social sharing
 * - Reading time calculation
 * - Blog components
 * - Newsletter components
 * - Glossary components
 * - Pagination
 */

// Secure Media Players
export {
  SecureVideoPlayer,
  type SecureVideoPlayerProps,
  type SecureVideoPlayerRef,
} from "./SecureVideoPlayer";

export {
  SecureDocumentViewer,
  type SecureDocumentViewerProps,
  type SecureDocumentViewerRef,
} from "./SecureDocumentViewer";

export {
  SecureAudioPlayer,
  type SecureAudioPlayerProps,
  type SecureAudioPlayerRef,
} from "./SecureAudioPlayer";

// Content Gating
export { PremiumContentGate } from "./PremiumContentGate";
export { default as PremiumContentGateDefault } from "./PremiumContentGate";

// SEO
export { StructuredData } from "./StructuredData";
export { default as StructuredDataDefault } from "./StructuredData";

// Social Sharing
export { ShareButtons } from "./ShareButtons";
export { default as ShareButtonsDefault } from "./ShareButtons";

// Reading Time
export { ReadingTime, calculateReadingTime } from "./ReadingTime";
export { default as ReadingTimeDefault } from "./ReadingTime";

// Blog Components
export { default as BlogCard } from "./BlogCard";
export { default as BlogContent } from "./BlogContent";

// Newsletter Components
export { NewsletterCard } from "./NewsletterCard";
export { NewsletterSubscribe } from "./NewsletterSubscribe";

// Glossary Components
export { GlossaryAlphabetNav } from "./GlossaryAlphabetNav";
export { GlossarySearch } from "./GlossarySearch";
export { GlossaryTermCard } from "./GlossaryTermCard";

// Pagination
export { ContentPagination } from "./ContentPagination";
