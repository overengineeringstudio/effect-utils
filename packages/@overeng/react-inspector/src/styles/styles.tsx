import React, { createContext, useContext, useMemo } from 'react'

import { createTheme } from './base.tsx'
import * as themes from './themes/index.tsx'

const DEFAULT_THEME_NAME = 'chromeLight'

const ThemeContext = createContext(createTheme(themes[DEFAULT_THEME_NAME]))

/**
 * Hook to get the component styles for the current theme.
 * @param {string} baseStylesKey - Name of the component to be styled
 */
export const useStyles = (baseStylesKey: string): any => {
  const themeStyles = useContext(ThemeContext) as any
  return themeStyles[baseStylesKey]
}

/**
 * HOC to create a component that accepts a "theme" prop and uses it to set
 * the current theme. This is intended to be used by the top-level inspector
 * components.
 * @param {Object} WrappedComponent - React component to be wrapped
 */
export const themeAcceptor = (WrappedComponent: React.FC<any>) => {
  const ThemeAcceptor = ({
    theme = DEFAULT_THEME_NAME,
    ...restProps
  }: {
    theme?: string | object
    [key: string]: unknown
  }) => {
    const themeStyles = useMemo(() => {
      switch (Object.prototype.toString.call(theme)) {
        case '[object String]':
          return createTheme((themes as Record<string, unknown>)[theme as string])
        case '[object Object]':
          return createTheme(theme)
        default:
          return createTheme(themes[DEFAULT_THEME_NAME])
      }
    }, [theme])

    return (
      <ThemeContext.Provider value={themeStyles}>
        <WrappedComponent {...restProps} />
      </ThemeContext.Provider>
    )
  }

  // ThemeAcceptor.propTypes = {
  //   theme: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
  // };

  return ThemeAcceptor
}
