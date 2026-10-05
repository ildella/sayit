<script>
  import { onMount } from 'svelte';
  import '../app.css';
  let { children } = $props();

  // Ctrl/Cmd+Q quits the app (window close is otherwise tray-only).
  onMount(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        window.__TAURI__?.core?.invoke('quit_app').catch(() => {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

{@render children()}
