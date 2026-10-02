import { Segmented, type SegmentedOption, type SegmentedProps } from '../forms/Segmented'

export interface IconToggleOption<V extends string = string> extends Omit<
  SegmentedOption<V>,
  'label' | 'icon'
> {
  icon: SegmentedOption<V>['icon']
  'aria-label': string
}

export interface IconToggleGroupProps<V extends string = string> extends Omit<
  SegmentedProps<V>,
  'options' | 'variant' | 'size' | 'textSize'
> {
  options: ReadonlyArray<IconToggleOption<V>>
}

/**
 * Inspector icon toggles on --color-input (r5, 22px items): fill type (26px items),
 * flex direction and text alignment (fullWidth).
 */
export function IconToggleGroup<V extends string = string>({
  options,
  ...rest
}: IconToggleGroupProps<V>) {
  return <Segmented<V> variant="input" size={22} options={options} {...rest} />
}
