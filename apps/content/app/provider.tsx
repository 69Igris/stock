"use client";

import React from "react";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { Toaster } from "sonner";
import { ContentSidebarLayout } from "./content-sidebar";
import { PostHogProvider } from "@/components/PostHogProvider";

export default function Provider({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      disableTransitionOnChange
    >
      <PostHogProvider>
        <TooltipProvider>
          <ContentSidebarLayout>{children}</ContentSidebarLayout>
        </TooltipProvider>
        <Toaster richColors position="bottom-right" />
      </PostHogProvider>
    </ThemeProvider>
  );
}
