import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import type { RefObject } from 'react'

gsap.registerPlugin(useGSAP, ScrollTrigger)

export function useKabandaMotion(scope: RefObject<HTMLElement | null>) {
  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

      const media = gsap.matchMedia()
      const statement = scope.current?.querySelector<HTMLElement>('[data-route-statement]')
      const words = statement?.querySelectorAll<HTMLElement>('span')

      media.add('(min-width: 621px)', () => {
        if (!statement || !words?.length) return

        gsap.fromTo(
          words,
          { opacity: 0.24, filter: 'blur(2px)' },
          {
            opacity: 1,
            filter: 'blur(0px)',
            stagger: 0.05,
            ease: 'none',
            scrollTrigger: {
              trigger: statement,
              start: 'top 82%',
              end: 'bottom 38%',
              scrub: true,
            },
          },
        )
      })

      media.add('(min-width: 1101px)', () => {
        const rail = scope.current?.querySelector<HTMLElement>('[data-journey-rail]')
        if (!rail || !scope.current) return

        ScrollTrigger.create({
          trigger: scope.current,
          start: 'top 24px',
          end: 'bottom bottom-=48',
          pin: rail,
          pinSpacing: false,
        })
      })

      return () => media.revert()
    },
    { scope },
  )
}
