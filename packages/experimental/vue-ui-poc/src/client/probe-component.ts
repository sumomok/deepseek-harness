/**
 * The probe's Vue half: a component whose only inputs are strings, a number,
 * and one callback, and whose only state is a Vue `ref`.
 *
 * `count` living in the ref rather than in React state is the point of the
 * probe: it proves the Vue reactivity system is running inside the bridge's
 * container, and that a React re-render patches the tree instead of remounting
 * it (the count survives while `echo` updates). Copy arrives already
 * translated — the locale registry is a React-side concern.
 */
import { defineComponent, h, ref, type PropType } from 'vue'
import css from './probe.module.css'

/** Vue probe component; see the module contract for what may cross the bridge. */
export const VueProbe = defineComponent({
  name: 'VueProbe',
  props: {
    /** Static line naming what mounted, already localized. */
    title: { type: String, required: true },
    /** Label preceding the Vue-owned counter, already localized. */
    countLabel: { type: String, required: true },
    /** Label preceding the value React sent back, already localized. */
    echoLabel: { type: String, required: true },
    /** Accessible name of the counter button, already localized. */
    buttonLabel: { type: String, required: true },
    /** The last count React received, handed back down as an ordinary prop. */
    echo: { type: Number, required: true },
    /** Reports each new count to the React side. */
    onCount: { type: Function as PropType<(value: number) => void>, required: true },
  },
  setup(props) {
    const count = ref(0)
    const increment = (): void => {
      count.value += 1
      props.onCount(count.value)
    }
    return () => h('span', { class: css.probe }, [
      h('span', { class: css.title }, props.title),
      h('button', {
        class: css.button,
        type: 'button',
        'aria-label': props.buttonLabel,
        onClick: increment,
      }, `${props.countLabel} ${count.value}`),
      h('span', { class: css.echo }, `${props.echoLabel} ${props.echo}`),
    ])
  },
})
