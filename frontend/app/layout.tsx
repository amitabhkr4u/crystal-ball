import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crystal Ball Command Centre - IoT Operations",
  description: "Multi-tenant IoT operations dashboard with AI alert intelligence"
};

// Wraps every page in the root HTML layout.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
