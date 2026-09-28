import { ref, watch, type Ref } from "vue";

/**
 * A field that shows a value the vault holds until the person starts
 * writing in it: what the vault says afterwards, while they write, is
 * not put over their words. Once the field shows the vault's value
 * again, it follows again.
 */
export function editableFrom(source: Ref<string>): Ref<string> {
  const field = ref(source.value);
  watch(source, (now, before) => {
    if (field.value === before) field.value = now;
  });
  return field;
}
