import { render, screen } from '@testing-library/react'
import Privacy from '@/app/privacy/page'
import { describe, it, expect } from 'vitest'

describe('Privacy Page Component', () => {
  it('renders privacy policy header', () => {
    render(<Privacy />)
    const heading = screen.getByRole('heading', { level: 1, name: /Privacy Policy/i })
    expect(heading).toBeInTheDocument()
  }, 10000)
})
