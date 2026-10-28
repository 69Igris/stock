"use client";

import { motion } from "framer-motion";

interface OrbitIcon {
  color: string;
  icon: React.ReactNode;
  delay: number;
}

interface LoaderStep {
  label: string;
  delay: number;
}

interface AnimatedPageLoaderProps {
  centerIcon: React.ReactNode;
  orbitIcons: [OrbitIcon, OrbitIcon, OrbitIcon];
  title: string;
  subtitle: string;
  steps: [LoaderStep, LoaderStep, LoaderStep];
}

export default function AnimatedPageLoader({
  centerIcon,
  orbitIcons,
  title,
  subtitle,
  steps,
}: AnimatedPageLoaderProps) {
  // Orbit icon positions
  const orbitPositions = [
    "absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1",
    "absolute bottom-0 right-0 translate-x-2 translate-y-2",
    "absolute bottom-0 left-0 -translate-x-2 translate-y-2",
  ];

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] gap-8">
      {/* Animated icon cluster */}
      <div className="relative w-40 h-40">
        {/* Pulsing rings */}
        <motion.div
          className="absolute inset-0 rounded-full border-2 border-primary/20"
          animate={{ scale: [1, 1.5, 1], opacity: [0.6, 0, 0.6] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute inset-2 rounded-full border-2 border-primary/30"
          animate={{ scale: [1, 1.2, 1], opacity: [0.8, 0.4, 0.8] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
        />

        {/* Center icon */}
        <motion.div
          className="absolute inset-0 flex items-center justify-center"
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          {centerIcon}
        </motion.div>

        {/* Orbiting icons */}
        {orbitIcons.map((orbit, i) => (
          <motion.div
            key={i}
            className={orbitPositions[i]}
            animate={{ y: [0, -8, 0] }}
            transition={{
              duration: 1.5,
              repeat: Infinity,
              ease: "easeInOut",
              delay: orbit.delay,
            }}
          >
            <div className={orbit.color}>{orbit.icon}</div>
          </motion.div>
        ))}
      </div>

      {/* Title + subtitle */}
      <motion.div
        className="text-center space-y-3"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
      >
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        <div className="flex items-center justify-center gap-2 text-muted-foreground">
          <motion.svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </motion.svg>
          <span className="text-sm">{subtitle}</span>
        </div>
      </motion.div>

      {/* Progress bar */}
      <div className="w-64 h-1.5 bg-muted rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-primary rounded-full"
          animate={{
            width: ["0%", "70%", "0%"],
            marginLeft: ["0%", "15%", "100%"],
          }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      {/* Steps indicator */}
      <motion.div
        className="flex items-center gap-6 text-xs text-muted-foreground"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
      >
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <motion.div
              className="w-2 h-2 rounded-full bg-primary"
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{
                duration: 1.5,
                repeat: Infinity,
                ease: "easeInOut",
                delay: step.delay,
              }}
            />
            {step.label}
          </div>
        ))}
      </motion.div>
    </div>
  );
}
