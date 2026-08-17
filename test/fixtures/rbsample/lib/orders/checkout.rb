require_relative '../payment/engine'


def checkout(amount)
  compute_fee(amount)
end
