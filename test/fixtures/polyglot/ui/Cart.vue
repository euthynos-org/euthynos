<template>
  <div>{{ subtotal }}</div>
</template>

<script setup lang="ts">
export function subtotal(price: number, qty: number): number {
  return price * qty;
}
</script>
