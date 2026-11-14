"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Archive, BookOpen, LayoutDashboard, Plug, Settings } from "lucide-react";

const destinations = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/objects", label: "Objects / History", icon: Archive },
  { href: "/devices", label: "Devices", icon: Plug },
  { href: "/control-guide", label: "Control Guide", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const section = pathname.startsWith("/sessions/") ? "/objects" : `/${pathname.split("/")[1]}`;

  return (
    <nav aria-label="Main navigation">
      <ul className="sidebar-links">
        {destinations.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link href={href} aria-current={pathname === href ? "page" : section === href ? "location" : undefined}>
              <Icon aria-hidden="true" size={18} />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
