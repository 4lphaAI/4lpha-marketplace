// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal immutable native-BNB invoice forwarder for 4lpha Phase 5.
contract BillingCollector {
    address payable public immutable treasury;
    mapping(bytes32 => bool) public paid;
    bool private entered;

    event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, uint256 amount);

    constructor(address payable treasury_) {
        require(treasury_ != address(0), "ZERO_TREASURY");
        treasury = treasury_;
    }

    function payInvoice(bytes32 invoiceId, uint64 quoteExpiresAt) external payable {
        require(!entered, "REENTRANT");
        require(invoiceId != bytes32(0), "ZERO_INVOICE");
        require(msg.value != 0, "ZERO_VALUE");
        require(quoteExpiresAt != 0, "ZERO_DEADLINE");
        require(block.timestamp <= quoteExpiresAt, "EXPIRED");
        require(!paid[invoiceId], "ALREADY_PAID");

        entered = true;
        paid[invoiceId] = true;
        (bool sent, ) = treasury.call{value: msg.value}("");
        require(sent, "TREASURY_TRANSFER_FAILED");
        emit InvoicePaid(invoiceId, msg.sender, msg.value);
        entered = false;
    }
}
