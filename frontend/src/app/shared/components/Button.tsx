import React from 'react';
import { styled } from '@linaria/react';
import { ButtonVariant, Pallete } from '@core/types';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.FC;
  pallete?: Pallete;
  variant?: ButtonVariant;
}

const BaseButtonStyled = styled.button<ButtonProps>`
  font-family: 'SFProDisplay', sans-serif;
  &[disabled] {
    opacity: 0.5;

    &:hover,
    &:active {
      box-shadow: none !important;
      cursor: default !important;
    }
  }
`;

const ButtonStyled = styled(BaseButtonStyled)`
  display: block;
  width: 100%;
  height: 37px;
  border: none;
  border-radius: 19px;
  background-color: ${({ pallete }) => `var(--color-${pallete})`};
  text-align: center;
  font-weight: 700;
  font-size: 14px;
  color: var(--color-dark-blue);

  &:hover,
  &:active {
    box-shadow: 0 0 8px white;
    cursor: pointer;
  }

  > svg {
    vertical-align: sub;
    margin-right: 10px;
  }
`;

const GhostButtonStyled = styled(ButtonStyled)`
  background-color: rgba(255, 255, 255, 0.1);
  color: white;

  &:hover,
  &:active {
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.15);
    background-color: rgba(255, 255, 255, 0.3);
  }
`;

const BlockButtonStyled = styled(GhostButtonStyled)`
  width: 100%;
  max-width: none;
  padding: 18px;
  border-radius: 10px;
  background-color: rgba(255, 255, 255, 0.03);
  font-size: 14px;
  text-align: left;
  text-transform: uppercase;
  letter-spacing: 3px;
  color: ${({ pallete }) => `var(--color-${pallete})`};

  &:hover,
  &:active {
    background-color: rgba(255, 255, 255, 0.1);
    box-shadow: none;
  }
`;

const IconButtonStyled = styled(BaseButtonStyled)`
  display: inline-block;
  font-family: 'ProximaNova', 'SFProDisplay', sans-serif;
  font-style: normal;
  font-weight: 700;
  font-size: 14px;
  line-height: 17px;
  vertical-align: sub;
  //margin: 0 10px;
  margin: 0 0 0 10px;
  padding: 0;
  background-color: transparent;
  border: none;
  cursor: pointer;
  color: ${({ pallete }) => `var(--color-${pallete})`};

  > svg {
    vertical-align: sub;
    //margin-right: 15px;
  }
`;

const LinkButtonStyled = styled(IconButtonStyled)`
  margin: 20px 0;
  font-size: 14px;
  font-weight: 700;
  color: ${({ pallete }) => `var(--color-${pallete})`};
`;
const ControlButtonStyled = styled(IconButtonStyled)`
  font-family: 'ProximaNova', 'SFProDisplay', sans-serif;
  font-style: normal;
  font-weight: 700;
  font-size: 14px;
  line-height: 17px;
  text-transform: lowercase;
  svg {
    margin-right: 16px;
    vertical-align: middle;
  }
`;
const TradeButtonStyled = styled(ButtonStyled)`
  font-style: normal;
  font-weight: 700;
  font-size: 14px;
  height: 33px;
  line-height: 17px;
  background: rgba(0, 246, 210, 0.1);
  color: ${({ pallete }) => `var(--color-${pallete})`};
  border-radius: 20px;
  border: ${({ pallete }) => `1px solid var(--color-${pallete})`};
`;

const ApproveButtonStyled = styled(ButtonStyled)`
  width: 182px;
  background-color: rgba(0, 246, 210, 1);
  color: var(--color-dark-blue);
  text-transform: lowercase;
  &:disabled {
    //color: var(--color-dark-blue);
    background-color: rgba(0, 246, 210, 0.3);
  }
`;
const WithdrawButtonStyled = styled(ApproveButtonStyled)`
  width: 151px;
  background: var(--color-blue);
`;
const CancelButtonStyled = styled(ApproveButtonStyled)`
  width: 151px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--color-white);
`;

const VARIANTS = {
  regular: ButtonStyled,
  ghost: GhostButtonStyled,
  link: LinkButtonStyled,
  icon: IconButtonStyled,
  block: BlockButtonStyled,
  control: ControlButtonStyled,
  trade: TradeButtonStyled,
  approve: ApproveButtonStyled,
  cancel: CancelButtonStyled,
  withdraw: WithdrawButtonStyled,
};

const Button: React.FC<ButtonProps> = ({
  type = 'button',
  pallete = 'green',
  variant = 'regular',
  icon: IconComponent,
  children,
  ...rest
}) => {
  const ButtonComponent = VARIANTS[variant];

  return (
    <ButtonComponent type={type} pallete={pallete} {...rest}>
      {!!IconComponent && <IconComponent />}
      {children}
    </ButtonComponent>
  );
};

export default Button;
