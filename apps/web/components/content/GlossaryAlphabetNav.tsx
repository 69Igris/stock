"use client";

import { cn } from "@usemoney/utils";

interface GlossaryAlphabetNavProps {
  activeLetters: string[];
  allLetters: string[];
}

export function GlossaryAlphabetNav({
  activeLetters,
  allLetters,
}: GlossaryAlphabetNavProps) {
  const handleClick = (letter: string) => {
    const element = document.getElementById(`letter-${letter}`);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <nav
      className="sticky top-16 z-10 bg-background/95 backdrop-blur-sm py-4 -mx-4 px-4 sm:-mx-6 sm:px-6"
      aria-label="Alphabet navigation"
    >
      <div className="flex flex-wrap gap-1.5 justify-center">
        {allLetters.map((letter) => {
          const isActive = activeLetters.includes(letter);

          return (
            <button
              key={letter}
              onClick={() => isActive && handleClick(letter)}
              disabled={!isActive}
              className={cn(
                "h-9 w-9 flex items-center justify-center rounded-md text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-muted text-foreground/80 hover:bg-cyan-500/20 hover:text-cyan-400 cursor-pointer"
                  : "bg-card/50 text-muted-foreground/50 cursor-not-allowed"
              )}
              aria-label={
                isActive
                  ? `Jump to ${letter} terms`
                  : `No terms starting with ${letter}`
              }
            >
              {letter}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
