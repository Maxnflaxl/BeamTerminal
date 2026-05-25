import React from 'react';
import Select, { components, Props } from 'react-select';
import { IOptions } from '@core/types';
import AssetIcon from '@app/shared/components/AssetsIcon';
import { CancelIcon, IconDropdownDown } from '@app/shared/icons';
import { styled } from '@linaria/react';

const AssetOptionRow = styled.div`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 8px;
  width: 100%;
  min-width: 0;
`;

const Ellipsis = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const AssetIdSuffix = styled.span`
  max-width: 12ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 400;
  font-size: 14px;
  line-height: 14px;
  color: rgba(255, 255, 255, 0.7);
  text-transform: lowercase;
  justify-self: end;
`;

const SingleValueRow = styled.div`
  display: flex;
  align-items: center;
  min-width: 0;
  width: 100%;
`;

interface IReactSelectProps extends Props {
  options: IOptions[];
  onChange: (any) => void;
  value?: IOptions | null;
  isFilter?: boolean;
  isIcon?: boolean;
  customPrefix?: string;
  hideValueWhileSearching?: boolean;
  ref?;
}

const ReactSelect = ({
  options,
  onChange,
  isFilter,
  isIcon,
  hideValueWhileSearching = false,
  ref,
  customPrefix = 'custom-select',
  styles: userStyles,
  ...rest
}: IReactSelectProps) => {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const noOptionsText = isFilter ? 'Type to search assets' : 'Select asset';
  const {
    Option, DropdownIndicator, ClearIndicator, SingleValue,
  } = components;

  function IconOption(props) {
    const { value, label } = props;
    return (
      // @ts-ignore
      <Option {...props}>
        {isIcon ? (
          <AssetOptionRow>
            <AssetIcon asset_id={value} />
            <Ellipsis>{label}</Ellipsis>
            <AssetIdSuffix title={`(id:${value})`}>{`(id:${value})`}</AssetIdSuffix>
          </AssetOptionRow>
        ) : (
          <span>{label}</span>
        )}
      </Option>
    );
  }

  function SingleValues(props) {
    const { data } = props;
    return (
      // @ts-ignore
      <SingleValue {...props}>
        {isIcon ? (
          <SingleValueRow>
            <AssetIcon asset_id={data.value} />
            <Ellipsis>{data.label}</Ellipsis>
          </SingleValueRow>
        ) : (
          <span>{data.label}</span>
        )}
      </SingleValue>
    );
  }

  function IndicatorSVG(props) {
    return (
      <DropdownIndicator {...props}>
        <IconDropdownDown />
      </DropdownIndicator>
    );
  }

  function IndicatorClear(props) {
    return (
      <ClearIndicator {...props}>
        <CancelIcon />
      </ClearIndicator>
    );
  }

  return (
    <Select
      classNamePrefix={customPrefix}
      options={options}
      isClearable
      isSearchable
      ref={ref}
      onChange={onChange}
      onMenuOpen={() => setMenuOpen(true)}
      onMenuClose={() => setMenuOpen(false)}
      controlShouldRenderValue={!hideValueWhileSearching || !menuOpen}
      noOptionsMessage={({ inputValue }) => (!inputValue ? noOptionsText : 'No assets were found')}
      components={{
        Option: IconOption,
        DropdownIndicator: IndicatorSVG,
        ClearIndicator: IndicatorClear,
        IndicatorSeparator: () => null,
        SingleValue: SingleValues,
      }}
      styles={userStyles}
      {...rest}
      {...((customPrefix === 'custom-filter' || customPrefix === 'custom-asset-select' || customPrefix === 'custom-kind')
        ? {
          menuPortalTarget: typeof document !== 'undefined' ? document.body : null,
          menuPosition: 'fixed' as const,
        }
        : {})}
    />
  );
};

export default ReactSelect;
