import { createContext } from 'react'

export interface AuthenticatedUser {
  id: number
  username: string
}

export interface AuthContextValue {
  user: AuthenticatedUser | null
  /** True while the initial session check against the server is still in flight. */
  checking: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
