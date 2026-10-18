// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { onActivateKey } from '../a11y';

function Row({ onPress }: { onPress: () => void }) {
  return (
    <div role="button" tabIndex={0} data-testid="row" onKeyDown={onActivateKey(onPress)}>
      <button type="button" data-testid="child">★</button>
    </div>
  );
}

describe('onActivateKey', () => {
  it('activates on Enter and Space, not on other keys', () => {
    const onPress = vi.fn();
    const { getByTestId } = render(<Row onPress={onPress} />);
    fireEvent.keyDown(getByTestId('row'), { key: 'Enter' });
    fireEvent.keyDown(getByTestId('row'), { key: ' ' });
    fireEvent.keyDown(getByTestId('row'), { key: 'a' });
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it('prevents the default for Space so the page does not scroll', () => {
    const { getByTestId } = render(<Row onPress={() => {}} />);
    const notCancelled = fireEvent.keyDown(getByTestId('row'), { key: ' ' });
    expect(notCancelled).toBe(false);
  });

  it('ignores keys pressed on a nested control inside the row', () => {
    const onPress = vi.fn();
    const { getByTestId } = render(<Row onPress={onPress} />);
    fireEvent.keyDown(getByTestId('child'), { key: 'Enter' });
    expect(onPress).not.toHaveBeenCalled();
  });
});
