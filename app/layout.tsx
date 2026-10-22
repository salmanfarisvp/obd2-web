import type { Metadata, Viewport } from "next";
import Nav from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = { title: "Ride Logger", description: "OBD2 ride and engine logger" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0e1116" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
