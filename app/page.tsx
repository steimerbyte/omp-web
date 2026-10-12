import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { AnimationProvider } from "@/components/motion/AnimationProvider";
import { I18nProvider } from "@/hooks/useI18n";

export default function Home() {
  return (
    <Suspense>
      <I18nProvider>
        <AnimationProvider>
          <AppShell />
        </AnimationProvider>
      </I18nProvider>
    </Suspense>
  );
}
