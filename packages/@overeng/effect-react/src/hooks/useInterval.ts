import React from 'react'

/** React hook for managing intervals with automatic cleanup */
export const useInterval = (callback: () => unknown, isActive: boolean, delay: number) => {
  const intervalRef = React.useRef<null | number>(null)
  const savedCallback = React.useRef(callback)

  React.useEffect(() => {
    savedCallback.current = callback
  }, [callback])

  React.useEffect(() => {
    if (isActive) {
      const tick = () => savedCallback.current()
      intervalRef.current = window.setInterval(tick, delay)
    }
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current)
      }
    }
  }, [delay, isActive])

  return intervalRef
}
