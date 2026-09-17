<script lang="ts">
  let count = $state(0);
</script>

<main class="svelte-app">
  <section id="counter-card" class="card">
    <p id="counter-note">Svelte-rendered at runtime</p>
    <button id="svelte-counter" class="primary" type="button" onclick={() => count++}>
      Count is {count}
    </button>
  </section>
</main>
