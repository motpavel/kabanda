import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

export function animateStatement(statement: HTMLElement): () => void {
  const context = gsap.context(() => {
    gsap.fromTo(statement.querySelectorAll('span'), { opacity: 0.35 }, {
      opacity: 1, stagger: 0.05, ease: 'none',
      scrollTrigger: { trigger: statement, start: 'top 82%', end: 'bottom 38%', scrub: true },
    })
  }, statement)
  return () => context.revert()
}
