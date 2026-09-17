<script setup lang="ts">
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <main class="vue-app">
    <section id="counter-card" class="card">
      <p id="counter-note">Vue-rendered at runtime</p>
      <button id="vue-counter" class="primary" type="button" @click="count++">
        Count is {{ count }}
      </button>
    </section>
  </main>
</template>
