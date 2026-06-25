import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";

const geist = Geist({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Dealinno — Close deals while you sleep",
  description: "AI that drafts your scheduling emails, records meetings, and delivers proposals in 60 seconds — automatically.",
  metadataBase: new URL("https://dealinno.vercel.app"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={geist.className}>
        {children}
        <Toaster theme="dark" position="bottom-right" />
      </body>
    </html>
  );
}
