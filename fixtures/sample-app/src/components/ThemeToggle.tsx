import { useEffect } from 'react';
import { useThemeStore } from '../state/themeStore';

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const next = theme === 'light' ? 'escuro' : 'claro';
  return (
    <button type="button" onClick={toggle} aria-pressed={theme === 'dark'} aria-label={`Ativar tema ${next}`}>
      Tema {theme === 'light' ? 'claro' : 'escuro'}
    </button>
  );
}
