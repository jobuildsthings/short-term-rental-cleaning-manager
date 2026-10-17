import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cleaning Manager",
  description: "Self-owned cleaning coordination for a short-term rental.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        {children}
      </body>
    </html>
  );
}
