import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NPRS Research Terminal - NEMESIS Progressive Recovery Strategy",
  description:
    "Quantitative research terminal for NPRS v1: leveraged trend-following with progressive averaging (DCA), deterministic backtesting, isolated-margin liquidation monitoring, funding-aware accounting and a full experiment registry.",
  keywords: [
    "backtesting",
    "quantitative research",
    "DCA strategy",
    "liquidation",
    "futures",
    "trading strategy",
  ],
  authors: [{ name: "NPRS Research" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "NPRS Research Terminal",
    description:
      "Deterministic research simulator for leveraged progressive-averaging strategies with liquidation monitoring.",
    siteName: "NPRS Research Terminal",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
