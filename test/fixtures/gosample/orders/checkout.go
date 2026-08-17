package orders

import "gosample/payment"

// Checkout computes the order total including fees.
func Checkout(amount int) int {
	fee := payment.ComputeFee(amount)
	return amount + fee
}
